// The CRM shell demo (demo/): a static build from the industry templates and a file server with no dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { build, buildData, industryIds } from "../demo/build.mjs";
import { createServer, frameAncestors, headersFor, loadFiles } from "../demo/server.mjs";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "kit-demo-"));
const result = build(out);

test("demo build covers every industry template", () => {
  const ids = industryIds();
  assert.equal(ids.length, 13);
  assert.ok(!ids.includes("all"), "the shared workflow folder is not an industry");
  assert.equal(result.industries, 13);
  for (const f of ["index.html", "app.js", "styles.css", "data.js"]) assert.ok(fs.existsSync(path.join(out, f)), f);
});

test("demo data carries every page, tab and workflow the templates name", () => {
  const data = buildData();
  for (const ind of data.industries) {
    const t = JSON.parse(fs.readFileSync(new URL(`../industries/${ind.id}/crm-shell/template.json`, import.meta.url)));
    assert.deepEqual(ind.pages.map((p) => p.slug), t.pages.map((p) => p.slug), ind.id);
    assert.deepEqual(ind.pages.map((p) => p.tabs.length), t.pages.map((p) => p.tabs.length), ind.id);
    assert.deepEqual(ind.workflows, t.workflows.map((w) => w.id), ind.id);
    for (const id of ind.workflows) assert.ok(data.workflows[id]?.name, `${ind.id}: ${id} missing`);
    assert.equal(ind.connectors.length, t.connectors.length, ind.id);
  }
});

test("data.js sets one global and evaluates on its own", () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(out, "data.js"), "utf8"), sandbox);
  assert.equal(sandbox.window.KIT_DEMO_DATA.industries.length, 13);
});

test("the demo page loads only its own files and reaches nothing outside", () => {
  const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  assert.deepEqual([...html.matchAll(/(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]).sort(), ["app.js", "data.js", "styles.css"]);
  assert.equal((html.match(/<(script|link|img|iframe|object|embed|base|meta\s+http-equiv)\b/gi) ?? []).length, 3, "only the two scripts and one stylesheet");
  const js = fs.readFileSync(path.join(out, "app.js"), "utf8");
  for (const banned of ["fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "localStorage", "sessionStorage", "indexedDB", "document.cookie", "innerHTML", "eval(", "new Function"]) assert.ok(!js.includes(banned), `app.js uses ${banned}`);
  assert.ok(!/https?:\/\/|\/\/[a-z0-9]/i.test(js + html + fs.readFileSync(path.join(out, "styles.css"), "utf8")), "no outside or protocol-relative URLs in the demo code");
});

test("frame-ancestors keeps only https origins (and localhost)", () => {
  assert.equal(frameAncestors(undefined), "'none'");
  assert.equal(frameAncestors(""), "'none'");
  assert.equal(frameAncestors("https://hub.example.com"), "https://hub.example.com");
  assert.equal(frameAncestors("https://a.example.com https://a.example.com/ http://localhost:3000"), "https://a.example.com http://localhost:3000");
  assert.equal(frameAncestors("http://hub.example.com https://x.example.com/path https://u:p@y.example.com * 'self' javascript:alert(1) https://z.example.com?q=1"), "'none'");
  assert.equal(frameAncestors("https://*.example.com https://a.com;script-src https://b.example.com"), "https://b.example.com", "wildcards and directive text are dropped");
});

test("every served file carries the strict policy", () => {
  const h = headersFor("/index.html", "https://hub.example.com");
  assert.match(h["Content-Security-Policy"], /default-src 'none'/);
  assert.match(h["Content-Security-Policy"], /script-src 'self';/);
  assert.match(h["Content-Security-Policy"], /connect-src 'none'/);
  assert.match(h["Content-Security-Policy"], /frame-ancestors https:\/\/hub\.example\.com$/);
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "no-referrer");
  assert.equal(h["Content-Type"], "text/html; charset=utf-8");
  // A sandboxed frame (the way a host embeds the demo) has an opaque origin; same-origin here would block app.js.
  assert.equal(headersFor("/app.js", "'none'")["Cross-Origin-Resource-Policy"], "cross-origin");
});

test("the server answers only its own files, GET and HEAD only", async () => {
  const server = createServer({ files: loadFiles(out), ancestors: "https://hub.example.com" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-security-policy"), /frame-ancestors https:\/\/hub\.example\.com/);
    assert.equal(home.headers.get("set-cookie"), null);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/data.js`)).status, 200);
    for (const p of ["/server.mjs", "/build.mjs", "/../package.json", "/%2e%2e/package.json", "/dist/app.js", "/nope"]) assert.equal((await fetch(`${base}${p}`)).status, 404, p);
    assert.equal((await fetch(`${base}/`, { method: "POST", body: "x" })).status, 405);
    assert.equal((await fetch(`${base}/`, { method: "PUT", body: "x" })).status, 405);
    for (const p of ["/nope", "/healthz"]) assert.match((await fetch(`${base}${p}`)).headers.get("content-security-policy") ?? "", /frame-ancestors https:\/\/hub\.example\.com/, `${p} lacks the policy`);
    assert.ok(server.headersTimeout <= 10_000 && server.requestTimeout <= 15_000, "short timeouts");
    const raw = await new Promise((resolve) => { let out = ""; const sock = net.connect(server.address().port, "127.0.0.1", () => sock.write("GET / HTTP/1.1\r\nHost: x\nBad\r\n\r\n")); sock.on("data", (d) => { out += d; }); sock.on("close", () => resolve(out)); });
    assert.match(raw, /^HTTP\/1\.1 400/); assert.match(raw, /frame-ancestors https:\/\/hub\.example\.com/, "a malformed request still gets the policy");
  } finally { server.close(); }
});

test("the demo files carry no em dashes", () => {
  const files = ["demo/build.mjs", "demo/server.mjs", "demo/README.md", "demo/Dockerfile", "demo/railway.json", "demo/src/index.html", "demo/src/app.js", "demo/src/styles.css"];
  for (const f of files) assert.ok(!fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8").includes(String.fromCharCode(0x2014)), `${f} has an em dash`);
});

test("a malformed address falls back to the overview instead of a blank page", () => {
  // Runs the page's real router against a fake location, with the built data.
  const js = fs.readFileSync(new URL("../demo/src/app.js", import.meta.url), "utf8");
  const router = js.slice(js.indexOf("  const byId = new Map"), js.indexOf("  // ---------- chrome"));
  const location = { hash: "" };
  const parse = vm.runInNewContext(`(() => { const DATA = data; ${router}; return parse; })()`, { data: buildData(), location, Map, URIError, decodeURIComponent, encodeURIComponent });
  for (const hash of ["#/%", "#/%E0%A4%A", "#/constructor", "#/__proto__/d/sales", "#/" + "x/".repeat(5000), "#/real-estate/%"]) {
    location.hash = hash;
    const r = parse();
    assert.ok(r.ind && typeof r.ind.name === "string", `${hash.slice(0, 30)} gave no industry`);
  }
  location.hash = "#/real-estate/approvals";
  assert.equal(parse().view, "approvals");
});

test("the demo's departments match the shell's", () => {
  const shell = fs.readFileSync(new URL("../shell/lib/shell/departments.ts", import.meta.url), "utf8");
  const list = shell.slice(shell.indexOf("export const DEPARTMENTS"), shell.indexOf("] as const"));
  const ids = [...list.matchAll(/id: "([^"]+)", title: "([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`);
  assert.ok(ids.length >= 9);
  assert.deepEqual(buildData().departments.map((d) => `${d.id}=${d.title}`), ids);
});

test("weekly schedules name their days", () => {
  const js = fs.readFileSync(new URL("../demo/src/app.js", import.meta.url), "utf8");
  const sandbox = {};
  vm.runInNewContext(js.slice(js.indexOf("const DAY ="), js.indexOf("// ---------- routing")) + ";globalThis.cronText = cronText;", sandbox);
  assert.equal(sandbox.cronText("0 19 * * 0"), "Sundays at 19:00 UTC");
  assert.equal(sandbox.cronText("0 23 * * 0-4"), "Sun to Thu at 23:00 UTC");
  assert.equal(sandbox.cronText("30 21 * * 1-5"), "Weekdays at 21:30 UTC");
  assert.equal(sandbox.cronText("0 22 * * *"), "Daily at 22:00 UTC");
  assert.equal(sandbox.cronText("*/15 * * * *"), "Every 15 minutes");
  assert.equal(sandbox.cronText("0 9 * * 0-7"), "Daily at 09:00 UTC");
  assert.equal(sandbox.cronText("0 9 * * 0,7"), "Sundays at 09:00 UTC");
  assert.equal(sandbox.cronText("0 9 * * 1,3"), "Mon and Wed at 09:00 UTC");
  for (const raw of ["0 9 15 * 1", "0 9 1 1 1", "*/0 * * * *", "0 99 * * *", "0 9 * * 5-2", "bad"]) assert.equal(sandbox.cronText(raw), raw, `${raw} is shown as written`);
  assert.equal(sandbox.cronText("0 9 1 * *"), "Monthly on day 1 at 09:00 UTC");
  assert.equal(sandbox.cronText("10,40 * * * *"), "Every hour at :10, :40");
});
