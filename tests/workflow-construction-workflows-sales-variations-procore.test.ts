// Variations workflow, Procore side (change events, tracked only). Every request goes to a fake network: no test reaches a real Procore account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { intake, draft, followUp } from "../industries/construction/workflows/sales/variations/index.ts";

const DIR = "industries/construction/workflows/sales/variations";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { procore: { projects: [{ id: "4242", name: "12 Smith St" }], stale_after_days: 10 } };
const NOW = new Date("2026-11-09T00:00:00Z"), DAY = 864e5;

type Hit = { method: string; path: string; query: URLSearchParams; headers: Headers };
let hits: Hit[] = [];
let events: any[] = [], body: (page: number) => any = (p) => (p === 1 ? events : []);

beforeEach(() => {
  hits = [];
  events = [
    { id: 1, number: "A001", title: "Extra footings", status: { id: 1, name: "open", mapped_to_status: "open" }, deleted_at: null, in_recycle_bin: false, created_at: "2026-11-01T00:00:00Z" },
    { id: 2, number: "A002", title: "Pricing done", status: { id: 2, name: "Priced", mapped_to_status: "closed" }, deleted_at: null, created_at: "2026-11-01T00:00:00Z" },
    { id: 3, number: "A003", title: "Binned", status: { name: "open", mapped_to_status: "open" }, deleted_at: "2026-11-02T00:00:00Z" },
    { id: 4, number: "A004", title: "In bin", status: { name: "open", mapped_to_status: "open" }, in_recycle_bin: true },
  ];
  body = (p) => (p === 1 ? events : []);
  setTransport({ sleep: async () => {}, log: () => {}, fetch: (async (url: any, init: any) => {
    const u = new URL(String(url)), m = init?.method ?? "GET";
    hits.push({ method: m, path: u.pathname, query: u.searchParams, headers: new Headers(init?.headers) });
    if (u.hostname !== "api.procore.com") return new Response("wrong host", { status: 404 });
    if (u.pathname === "/rest/v1.1/change_events" && m === "GET") return new Response(JSON.stringify(body(Number(u.searchParams.get("page") ?? 1))), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not faked: " + m + " " + u.pathname, { status: 404 });
  }) as any });
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { PROCORE_ACCESS_TOKEN: "pc-token", PROCORE_COMPANY_ID: "777", KIT_ALLOW_WRITES: "1" });
});

test("intake records each live change event once with the project id and company header, writes nothing", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await intake(ctx), { added: 2 });
  assert.ok(await store.get("procoreChanges", "4242:1")); assert.ok(await store.get("procoreChanges", "4242:2"));
  assert.equal(await store.get("procoreChanges", "4242:3"), undefined, "a deleted event is not recorded");
  assert.equal(await store.get("procoreChanges", "4242:4"), undefined, "a recycle-bin event is not recorded");
  assert.ok(hits.every((h) => h.method === "GET"));
  assert.equal(hits[0].query.get("project_id"), "4242"); assert.equal(hits[0].headers.get("procore-company-id"), "777");
  assert.deepEqual(await intake(ctx), { added: 0 });
  assert.equal(Object.keys(await store.list("enquiries")).length, 0, "no ServiceM8-style enquiry is made");
});

test("draft does nothing and calls nothing under Procore", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await draft(ctx), { drafted: 0, needs_pricing: 0 });
  assert.equal(hits.length, 0);
});

test("follow-up logs an event still open past the window once, and queues nothing", async () => {
  const store = new MemoryStore();
  await intake(context(WF, SETTINGS, store, NOW, () => {}));
  const later = context(WF, SETTINGS, store, new Date(NOW.getTime() + 11 * DAY), () => {});
  assert.deepEqual(await followUp(later), { queued: 0, stale: 1 });
  assert.deepEqual(await followUp(later), { queued: 0, stale: 0 }, "logged once");
  assert.deepEqual(await followUp(context(WF, SETTINGS, new MemoryStore(), NOW, () => {})), { queued: 0, stale: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("setting procore together with the ServiceM8 variation settings is refused before any call", async () => {
  for (const extra of [{ variation_words: ["x"] }, { variation_templates: [] }, { follow_up: { after_days: [3] } }]) {
    const ctx = context(WF, { ...SETTINGS, ...extra }, new MemoryStore(), NOW, () => {});
    await assert.rejects(intake(ctx), /either the ServiceM8 variation settings or procore/);
  }
  assert.equal(hits.length, 0);
});

test("a non-list reply, a row with no id, a project past 20 pages and a bad project id each refuse the read", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  body = () => ({ error: "x" });
  await assert.rejects(intake(ctx), /did not come back as a list/);
  body = (p) => (p === 1 ? [{ title: "no id" }] : []);
  await assert.rejects(intake(ctx), /no usable id/);
  body = (p) => [{ id: p, number: "n", title: "t", status: { mapped_to_status: "closed" } }];
  await assert.rejects(intake(ctx), /longer than 20 pages/);
  const n = hits.length;
  await assert.rejects(intake(context(WF, { procore: { projects: [{ id: "../1", name: "x" }] } }, new MemoryStore(), NOW, () => {})), /bad id/);
  assert.equal(hits.length, n);
});

test("runtime: the change event list is a draft operation and cannot be queued", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.queue({ platform: "procore", op: "change-events.list-change-events", summary: "x" }), /not a live operation/);
});
