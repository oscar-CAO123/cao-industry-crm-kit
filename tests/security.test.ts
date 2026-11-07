// Penetration tests for the helper layer. Each test is an attack; it passes when the attack fails.
// Everything runs against a fake network: no keys, no real accounts.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { call, checkUrl, setTransport, WriteBlocked, ApiError, isRead, type AppSpec } from "../core/lib/http.ts";
import { FileTokenStore, MemoryTokenStore, setTokenStore, MissingSecret, secret } from "../core/lib/secrets.ts";
import * as gmail from "../core/connectors/google-workspace/gmail.ts";
import * as fireflies from "../core/connectors/fireflies/client.ts";
import * as meta from "../core/connectors/meta-ads/client.ts";
import * as telegram from "../core/connectors/telegram/client.ts";
import * as zoom from "../core/connectors/zoom/client.ts";

type Hit = { url: string; method: string; headers: Record<string, string>; body?: string };
let hits: Hit[] = [];
let logs: string[] = [];
function fake(route: (h: Hit) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }) {
  hits = []; logs = [];
  setTransport({
    fetch: (async (url: any, init: any) => {
      const h: Hit = { url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body };
      hits.push(h);
      const r = route(h); const st = r.status ?? 200;
      const body = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
      return new Response(st === 204 || st === 304 ? null : body, { status: st, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
    }) as typeof fetch,
    sleep: async () => {},
    log: (l) => logs.push(l),
  });
}
beforeEach(() => { delete process.env.KIT_ALLOW_WRITES; setTokenStore(new MemoryTokenStore()); });

const spec: AppSpec = { app: "demo", hosts: ["api.example.com"], readPosts: ["api.example.com/graphql"] };
const refused = async (url: string, why?: RegExp) => {
  fake(() => ({ json: {} }));
  await assert.rejects(call(spec, { url }), why ?? /refused|not one of this app's hosts|Invalid URL/);
  assert.equal(hits.length, 0, `no request may leave for ${url}`);
};

test("host: look-alikes, user-info tricks, IPs, ports and plain http never leave", async () => {
  for (const u of [
    "https://api.example.com.evil.org/x", "https://evil.org/api.example.com", "https://api.example.com@evil.org/x",
    "https://evil.org#@api.example.com", "https://127.0.0.1/x", "https://[::1]/x", "https://169.254.169.254/latest/meta-data",
    "http://api.example.com/x", "https://api.example.com:8443/x", "https://api.example.com./x", "https://xn--pi-api.example.com/x",
    "file:///etc/passwd", "javascript:alert(1)", "ftp://api.example.com/x",
  ]) await refused(u);
});

test("host: a hostPattern cannot be satisfied by a look-alike", () => {
  const z: AppSpec = { app: "zoom", hosts: ["api.zoom.us"], hostPattern: /^([a-z0-9-]+\.)+zoom\.us$/ };
  for (const u of ["https://zoom.us.evil.org/x", "https://evilzoom.us/x", "https://a.zoom.us.evil.org/x", "https://zoom.us@evil.org/x"]) {
    assert.throws(() => checkUrl(z, new URL(u)), /not one of this app.s hosts|credentials in a URL/, u);
  }
});

test("keys: a key in the query is refused however its name is written", async () => {
  for (const u of ["https://api.example.com/x?access_token=1", "https://api.example.com/x?ACCESS_TOKEN=1", "https://api.example.com/x?a=1&token=2",
    "https://api.example.com/x?access%5Ftoken=1", "https://api.example.com/x?api%5Fkey=1", "https://api.example.com/x?Api-Key=1", "https://api.example.com/x?apikey=1"]) {
    await refused(u, /query string/);
  }
});

test("redirects: a normal call never follows one, so a key is never replayed elsewhere", async () => {
  fake(() => ({ status: 307, headers: { location: "https://evil.org/steal" } }));
  await assert.rejects(call(spec, { url: "https://api.example.com/x", headers: { Authorization: "Bearer K" } }), ApiError);
  assert.equal(hits.length, 1);
});

test("redirects: a download never follows to http, and drops the key off the app's hosts", async () => {
  const z: AppSpec = { app: "dl", hosts: ["api.example.com"] };
  fake(() => ({ status: 302, headers: { location: "http://api.example.com/f" } }));
  await assert.rejects(call(z, { url: "https://api.example.com/d", headers: { Authorization: "Bearer K" }, binary: true, followDownloadRedirects: true }), /refused/);
  fake((h) => h.url.includes("api.example.com") ? { status: 302, headers: { location: "https://storage.example.net/f" } } : { text: "ok" });
  await call(z, { url: "https://api.example.com/d", headers: { Authorization: "Bearer K", authorization: "Bearer K2" }, binary: true, followDownloadRedirects: true });
  assert.ok(!Object.keys(hits[1].headers).some((k) => k.toLowerCase() === "authorization"), "no key of any case reaches storage");
});

test("writes: no method, path or case trick gets a write past the gate", async () => {
  fake(() => ({ json: {} }));
  for (const [method, url] of [["POST", "https://api.example.com/graphqlx"], ["POST", "https://api.example.com/graphql/../admin"], ["PUT", "https://api.example.com/graphql"],
    ["PATCH", "https://api.example.com/x"], ["DELETE", "https://api.example.com/x"], ["POST", "https://api.example.com/GRAPHQL"]] as const) {
    await assert.rejects(call(spec, { method, url, json: {} }), WriteBlocked, `${method} ${url}`);
  }
  assert.equal(hits.length, 0);
  assert.equal(isRead(spec, "POST", new URL("https://api.example.com/graphql")), true);
});

test("logs and errors: no key, email or query value is ever printed", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  fake(() => ({ status: 500, json: { secret: "CLIENT-DATA" } }));
  const url = "https://api.example.com/users/jo.smith@client.com.au/recordings";
  let msg = "";
  try { await call(spec, { url, query: { from: "2026-01-01", q: "secret search" }, headers: { Authorization: "Bearer SECRET-KEY" }, retries: 0 }); } catch (e: any) { msg = e.message; }
  const all = [msg, ...logs].join("\n");
  for (const bad of ["SECRET-KEY", "CLIENT-DATA", "secret search", "jo.smith@client.com.au"]) assert.ok(!all.includes(bad), `leaked: ${bad}`);
});

test("telegram: the bot key never appears in logs or errors", async () => {
  process.env.KIT_ALLOW_WRITES = "1"; process.env.TELEGRAM_BOT_TOKEN = "123456:SECRETBOTKEY";
  fake(() => ({ status: 400, json: {} }));
  let msg = "";
  try { await telegram.sendMessage("1", "hi"); } catch (e: any) { msg = e.message; }
  assert.ok(![msg, ...logs].join("\n").includes("SECRETBOTKEY"));
});

test("graphql: a mutation cannot be smuggled through the read path", async () => {
  process.env.FIREFLIES_API_KEY = "k";
  fake(() => ({ json: { data: {} } }));
  for (const q of ["mutation { x }", "query A { a } mutation B { b }", "query { a } MUTATION { b }", "  \n mutation{x}", "subscription { a }", "{ a } mutation { b }"]) {
    await assert.rejects(fireflies.query(q), /only read/, q);
  }
  assert.equal(hits.length, 0);
});

test("email: no header can be injected through any field", () => {
  const raw = (d: any) => Buffer.from(gmail.rawMessage({ from: "a@b.com", to: "c@d.com", subject: "s", text: "t", ...d }), "base64url").toString();
  assert.throws(() => raw({ to: "c@d.com\r\nBcc: x@y.com" }), /plain email address/);
  assert.throws(() => raw({ cc: "c@d.com\nBcc: x@y.com" }), /plain email address/);
  assert.throws(() => raw({ to: "Jo <c@d.com>" }), /plain email address/);
  for (const d of [{ subject: "hi\r\nBcc: x@y.com" }, { inReplyTo: "<m@x>\r\nBcc: x@y.com" }, { fromName: "Sam\r\nBcc: x@y.com" }, { toName: "Jo\nBcc: x@y.com" }]) {
    const head = raw(d).split("\r\n\r\n")[0];
    assert.ok(!/\r\nBcc:/i.test(head), JSON.stringify(d));
  }
});

test("token store: a key name cannot walk out of the token folder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-tok-"));
  const s = new FileTokenStore(dir);
  for (const k of ["../escape", "a/b", "..", "/etc/passwd", "x\u0000y", "x y"]) {
    await assert.rejects(s.set(k, "v"), /bad token key/, k);
  }
  await s.set("xero.refresh_token", "r1");
  const mode = fs.statSync(path.join(dir, "xero.refresh_token")).mode & 0o777;
  assert.equal(mode, 0o600, "token file is owner-only");
  assert.equal(fs.statSync(dir).mode & 0o077, 0, "token folder is owner-only");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("secrets: a missing key names the variable, never a value", () => {
  delete process.env.SOME_KEY;
  assert.throws(() => secret("SOME_KEY"), (e: any) => e instanceof MissingSecret && e.message.startsWith("SOME_KEY"));
});

test("meta: a paging link pointing elsewhere, or carrying a key, is neutralised", () => {
  assert.throws(() => meta.cleanNext("https://evil.org/next?after=1"), /not one of this app's hosts/);
  const c = meta.cleanNext("https://graph.facebook.com/v21.0/act_1/insights?after=2&access_token=LEAK")!;
  assert.ok(!c.includes("access_token") && !c.includes("LEAK"));
});

test("zoom: a recording file link to another host gets no key", async () => {
  process.env.ZOOM_ACCOUNT_ID = "a"; process.env.ZOOM_CLIENT_ID = "b"; process.env.ZOOM_CLIENT_SECRET = "c";
  zoom.clearTokenCache();
  fake((h) => h.url.includes("oauth/token") ? { json: { access_token: "ZK", expires_in: 3600 } } : { text: "x" });
  await assert.rejects(zoom.download({ file_type: "TIMELINE", download_url: "https://evil.org/file" }), /not one of this app's hosts/);
  assert.ok(!hits.some((h) => h.url.includes("evil.org")));
});

test("json: a hostile reply cannot pollute objects", async () => {
  fake(() => ({ text: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}' }));
  await call(spec, { url: "https://api.example.com/x" });
  assert.equal(({} as any).polluted, undefined);
});
