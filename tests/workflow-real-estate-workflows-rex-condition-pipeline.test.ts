// Condition and pipeline workflows, Rex side. Every request goes to a fake network: no test reaches a real Rex account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { properties, contacts } from "../industries/real-estate/workflows/fulfilment/condition/index.ts";
import { pipelineSync, prospectReview } from "../industries/real-estate/workflows/sales/pipeline/index.ts";

const load = (d: string) => JSON.parse(fs.readFileSync(`industries/real-estate/workflows/${d}/workflow.json`, "utf8")) as WorkflowRecord;
const COND = load("fulfilment/condition"), PIPE = load("sales/pipeline");
const OPS = new Set((JSON.parse(fs.readFileSync("core/sdk/platforms/rex/ops.json", "utf8")) as { id: string }[]).map((o) => o.id));
const NOW = new Date("2026-11-09T00:00:00Z");
const S: any = { platform: "rex" };

type Hit = { method: string; path: string; body: any; headers: Headers };
let hits: Hit[] = [];
let propRows: any[] = [], contactRows: any[] = [];
let page: (svc: string, offset: number) => any;

beforeEach(() => {
  hits = [];
  propRows = [
    { id: "2", system_search_key: "2 / 265 Roberts Road, Subiaco WA 6008", system_record_state: "active" },
    { id: "3", system_search_key: "Archived house", system_record_state: "archived" },
  ];
  contactRows = [
    { id: "6", name: "Will Wyman", email_address: "w@example.com", phone_number: "0411 000 000", system_modtime: "1557818752", system_record_state: "active" },
    { id: "7", name: "Ann Lee", email_address: "a@example.com", system_modtime: "1557818999", system_record_state: "active" },
  ];
  page = (svc, off) => ({ result: { rows: off === 0 ? (svc === "properties" ? propRows : contactRows) : [], total: 2 }, error: null });
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => {
    const u = new URL(String(url)); let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    hits.push({ method: init?.method ?? "GET", path: u.pathname, body, headers: new Headers(init?.headers) });
    const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
    if (u.hostname !== "api.rexsoftware.com") return new Response("wrong host", { status: 404 });
    let m = /^\/v1\/rex\/(properties|contacts)\/search$/.exec(u.pathname);
    if (m) return json(page(m[1], body?.offset ?? 0));
    if (u.pathname === "/v1/rex/contacts/read") return json({ result: { name: "Will Wyman", email_address: "w2@example.com", phone_number: "0422 000 000", system_modtime: "1557999999" }, error: null });
    return new Response("not faked: " + u.pathname, { status: 404 });
  }) as any });
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { REX_ACCESS_TOKEN: "rex-token" }); delete process.env.KIT_ALLOW_WRITES;
});

test("every Rex draft op is a mapped read operation, none is live", () => {
  for (const w of [COND, PIPE]) { for (const op of w.draft_ops.rex) assert.ok(OPS.has(op), `${op} is mapped`); assert.deepEqual(w.live_ops.rex ?? [], []); }
});

test("condition on Rex: reads properties and contacts through POST searches, skips archived rows, writes nothing", async () => {
  const store = new MemoryStore(), ctx = context(COND, S, store, NOW, () => {});
  assert.deepEqual(await properties(ctx), { read: 1 });
  const p = (await store.get<any>("properties", "2")) as any;
  assert.equal(p.address, "2 / 265 Roberts Road, Subiaco WA 6008"); assert.equal(await store.get("properties", "3"), undefined);
  assert.deepEqual(await contacts(ctx), { read: 2 });
  assert.equal(((await store.get<any>("contacts", "6")) as any).name, "Will Wyman");
  assert.ok(hits.every((h) => h.method === "POST" && /^\/v1\/rex\//.test(h.path)));
  assert.equal(hits[0].headers.get("authorization"), "Bearer rex-token");
  assert.deepEqual([hits[0].body.limit, hits[0].body.offset, hits[1].body.offset], [50, 0, 50], "paged by offset to an empty page");
});

test("condition: without platform set, the AgentBox path is unchanged, and a bad platform is refused", async () => {
  await assert.rejects(properties(context(COND, { platform: "x" }, new MemoryStore(), NOW, () => {})), /platform must be agentbox or rex/);
  assert.equal(hits.length, 0);
});

test("Rex lists refuse the whole read for a non-list reply, a Rex error, a bad row id, and a list past 20 pages", async () => {
  const ctx = context(COND, S, new MemoryStore(), NOW, () => {});
  page = () => ({ result: {}, error: null }); await assert.rejects(properties(ctx), /did not come back as a list/);
  page = () => ({ result: { rows: [] }, error: { message: "x" } }); await assert.rejects(properties(ctx), /returned an error/);
  page = (_s, o) => ({ result: { rows: o === 0 ? [{ id: "../x" }] : [] }, error: null }); await assert.rejects(properties(ctx), /no usable id/);
  page = (_s, o) => ({ result: { rows: [{ id: String(o + 1) }] }, error: null }); await assert.rejects(properties(ctx), /longer than 20 pages/);
});

test("pipeline on Rex: adds each contact once, refreshes one whose modified stamp changed, and the detail read goes to contacts.read", async () => {
  const store = new MemoryStore(), ctx = context(PIPE, S, store, NOW, () => {});
  assert.deepEqual(await pipelineSync(ctx), { seen: 2, added: 2, updated: 0 });
  const a = (await store.get<any>("prospects", "6")) as any;
  assert.equal(a.name, "Will Wyman"); assert.equal(a.email, "w@example.com"); assert.equal(a.modified, "1557818752");
  contactRows[0].system_modtime = "1558000000";
  assert.deepEqual(await pipelineSync(ctx), { seen: 2, added: 0, updated: 1 });
  assert.deepEqual(await prospectReview(ctx), { detailed: 2, untracked: 2, due: 0 });
  assert.ok(hits.some((h) => h.path === "/v1/rex/contacts/read" && h.body.id === 6));
  assert.equal(((await store.get<any>("prospects", "6")) as any).email, "w2@example.com");
  assert.ok(hits.every((h) => h.method === "POST"));
});

test("pipeline on Rex: a contact id that is not a Rex id never reaches the detail read", async () => {
  const store = new MemoryStore(); await store.put("prospects", "OXF1", { id: "OXF1", name: "x", first_seen: NOW.toISOString(), stage: "untracked" });
  await assert.rejects(prospectReview(context(PIPE, S, store, NOW, () => {})), /bad contact id/);
  assert.equal(hits.length, 0);
});
