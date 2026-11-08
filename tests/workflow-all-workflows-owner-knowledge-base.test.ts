// Knowledge base workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore, tokenStore } from "../core/lib/secrets.ts";
import { refreshKey } from "../core/connectors/google-workspace/auth.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { gather, draft } from "../industries/all/workflows/owner/knowledge-base/index.ts";
import fs from "node:fs";

const DIR = "industries/all/workflows/owner/knowledge-base";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const MAILBOX = "ops@example.com", FOLDER = "FOLDER0123456789", DOC = "DOC0123456789ab";
type Hit = { method: string; host: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, host: u.host, path: p, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      // Confluence (acme.atlassian.net)
      if (p === "/wiki/api/v2/pages" && m === "GET") return json({ results: [
        { id: "111", title: "Hot water safety", createdAt: "2026-11-01T00:00:00Z", version: { number: 1, createdAt: "2026-11-01T00:00:00Z" }, body: { storage: { value: "<p>Isolate the <b>valve</b> first.</p>" } } },
        { id: "333", title: "Old call-out steps", createdAt: "2023-01-01T00:00:00Z", version: { number: 4, createdAt: "2024-01-01T00:00:00Z" }, body: { storage: { value: "<p>Call the office.</p>" } } }] });
      if (p === "/wiki/api/v2/pages" && m === "POST") return json({ id: "222", status: "draft", version: { number: 1 } });
      if (p === "/wiki/api/v2/pages/222" && m === "PUT") return json({ id: "222", status: "current", version: { number: 2 } });
      // Google Drive and Docs
      if (u.host === "www.googleapis.com" && p === "/drive/v3/files") return json({ files: [{ id: DOC, name: "Quote checklist", mimeType: "application/vnd.google-apps.document" }] });
      if (u.host === "docs.googleapis.com" && p === `/v1/documents/${DOC}`) return json({ title: "Quote checklist", body: { content: [
        { paragraph: { elements: [{ textRun: { content: "Check the rate card first.\n" } }] } }] } });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const sends = () => hits.filter((h) => /\/send$|\/messages\/[^/]+\/send$/.test(h.path));
const writes = (method: string) => hits.filter((h) => h.method === method && h.host === "acme.atlassian.net");
const SET: any = { family: "all", business_name: "Test Trades", know_how: ["confluence", "google-workspace"],
  confluence: { source_space_id: "123456", kb_space_id: "234567" }, google: { folder_id: FOLDER, max_docs: 5 }, stale_after_days: 180 };
const NOW = new Date("2026-11-08T00:00:00Z");
const OUTLINE = { title: "Hot water <b>call-out</b>", purpose: "Isolate and check the valve.", steps: ["Turn off the cold isolation valve.", "Check the <script>alert(1)</script> pressure."] };

beforeEach(async () => {
  fake(); setTokenStore(new MemoryTokenStore());
  await tokenStore().set(refreshKey(MAILBOX), "r1");
  Object.assign(process.env, { CONFLUENCE_EMAIL: "ops@example.com.au", CONFLUENCE_API_TOKEN: "ct", CONFLUENCE_SITE: "acme.atlassian.net",
    GOOGLE_MAILBOX: MAILBOX, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a live operation cannot run as a draft, and a draft operation cannot be queued as live", async () => {
  const ctx = context(WF, SET, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "confluence", op: "openapi-v2-v3.updatePage", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "confluence", op: "openapi-v2-v3.createPage", summary: "x" }), /not a live operation/);
  await assert.rejects(ctx.draft({ platform: "google-workspace", op: "drive.permissions.create", summary: "x" }), /not a draft operation/);
});

test("gather: existing pages and docs become sources once, the old page is flagged stale, and nothing is written", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  assert.deepEqual(await gather(ctx), { added: 3, refreshed: 0, stale: 1 });
  assert.equal((await store.get<any>("sources", "confluence:333"))?.stale, true);
  assert.equal((await store.get<any>("sources", "confluence:111"))?.stale, false);
  assert.match((await store.get<any>("sources", `google:${DOC}`))?.text, /Check the rate card first\./);
  assert.deepEqual(await gather(ctx), { added: 0, refreshed: 3, stale: 1 }, "re-runs add nothing new");
  assert.equal(writes("POST").length + writes("PUT").length, 0, "gather writes nothing");
});

test("draft: a source without an outline is parked; with one, a draft page is made and its publish is queued, never sent", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await gather(ctx);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_writing: 3, published: 0 });
  await store.put("proposals", "confluence:111", OUTLINE);
  assert.deepEqual(await draft(ctx), { drafted: 1, needs_writing: 2, published: 0 });
  assert.equal(writes("POST").length, 1, "one draft page, and no publish yet");
  assert.equal(writes("PUT").length, 0, "publish waits for approval");
  const page = writes("POST")[0].body;
  assert.equal(page.status, "draft");
  assert.equal(page.spaceId, "234567");
  assert.equal(page.body.value, "<p>Isolate and check the valve.</p><ol><li>Turn off the cold isolation valve.</li><li>Check the &lt;script&gt;alert(1)&lt;/script&gt; pressure.</li></ol>");
  assert.equal(page.title, "KB: Hot water <b>call-out</b>");
  assert.equal(sends().length, 0);
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_writing: 2, published: 0 }, "re-runs never draft or queue twice");
  assert.equal(writes("POST").length, 1);
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.deepEqual(aps[0].acts.map((a) => a.op), ["openapi-v2-v3.updatePage"]);
});

test("approval publishes the page with the next version number; the next draft run marks it published", async () => {
  const store = new MemoryStore(), ctx = context(WF, SET, store, NOW, () => {});
  await gather(ctx);
  await store.put("proposals", "confluence:111", OUTLINE);
  await draft(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  const put = writes("PUT")[0];
  assert.equal(put.path, "/wiki/api/v2/pages/222");
  assert.equal(put.body.status, "current");
  assert.equal(put.body.version.number, 2);
  assert.deepEqual(await draft(context(WF, SET, store, NOW, () => {})), { drafted: 0, needs_writing: 2, published: 1 });
  assert.equal((await store.get<any>("sources", "confluence:111"))?.status, "published");
});
