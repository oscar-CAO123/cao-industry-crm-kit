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
    if (u.searchParams.get("project_id") === "9999") return new Response("boom", { status: 404 });
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
  await assert.rejects(intake(ctx), /not read/);
  const n = hits.length;
  await assert.rejects(intake(context(WF, { procore: { projects: [{ id: "../1", name: "x" }] } }, new MemoryStore(), NOW, () => {})), /bad id/);
  assert.equal(hits.length, n);
});

test("runtime: the change event list is a draft operation and cannot be queued", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.queue({ platform: "procore", op: "change-events.list-change-events", summary: "x" }), /not a live operation/);
});

test("a recorded event that is later deleted, or reopened, or old when first seen, gets the right stale clock", async () => {
  const store = new MemoryStore(), c0 = context(WF, SETTINGS, store, NOW, () => {});
  events[0].created_at = "2026-10-01T00:00:00Z";            // already 39 days old on first sight
  await intake(c0);
  assert.equal(((await store.get<any>("procoreChanges", "4242:1")) as any).open_since, "2026-10-01T00:00:00.000Z");
  assert.deepEqual(await followUp(c0), { queued: 0, stale: 1 }, "stale straight away, from its created date");
  // reopen: closed then open again starts a new clock
  const d1 = context(WF, SETTINGS, store, new Date(NOW.getTime() + DAY), () => {});
  events[0].status = { name: "Closed", mapped_to_status: "closed" }; await intake(d1);
  const d30 = new Date(NOW.getTime() + 30 * DAY); events[0].status = { name: "open", mapped_to_status: "open" };
  await intake(context(WF, SETTINGS, store, d30, () => {}));
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, new Date(d30.getTime() + DAY), () => {})), { queued: 0, stale: 0 }, "open one day: not stale");
  // deleted: the list stops returning it, it is marked gone and never chased
  events.splice(0, 1);
  const d60 = new Date(NOW.getTime() + 60 * DAY);
  await intake(context(WF, SETTINGS, store, d60, () => {}));
  assert.ok(((await store.get<any>("procoreChanges", "4242:1")) as any).gone);
  assert.deepEqual(await followUp(context(WF, SETTINGS, store, new Date(d60.getTime() + 40 * DAY), () => {})), { queued: 0, stale: 0 });
});

test("a removed project is no longer chased, and 101 projects are refused", async () => {
  const store = new MemoryStore(); await intake(context(WF, SETTINGS, store, NOW, () => {}));
  const other: any = { procore: { projects: [{ id: "9", name: "Other" }], stale_after_days: 10 } };
  assert.deepEqual(await followUp(context(WF, other, store, new Date(NOW.getTime() + 20 * DAY), () => {})), { queued: 0, stale: 0 });
  const many: any = { procore: { projects: Array.from({ length: 101 }, (_, i) => ({ id: String(i + 1), name: "p" })) } };
  await assert.rejects(intake(context(WF, many, new MemoryStore(), NOW, () => {})), /more than 100 projects/);
});

test("the default stale window is 14 days", async () => {
  const store = new MemoryStore(), s: any = { procore: { projects: SETTINGS.procore.projects } };
  events[0].created_at = NOW.toISOString();
  await intake(context(WF, s, store, NOW, () => {}));
  assert.equal((await followUp(context(WF, s, store, new Date(NOW.getTime() + 13 * DAY), () => {}))as any).stale, 0);
  assert.equal((await followUp(context(WF, s, store, new Date(NOW.getTime() + 15 * DAY), () => {}))as any).stale, 1);
});

test("two projects: one failing read marks nothing gone in the other, and the run fails loudly", async () => {
  const two: any = { procore: { projects: [{ id: "4242", name: "A" }, { id: "9999", name: "B" }] } };
  const store = new MemoryStore();
  await store.put("procoreChanges", "9999:77", { number: "X", title: "t", status: "open", project: "B", project_id: "9999", open_since: NOW.toISOString() });
  await assert.rejects(intake(context(WF, two, store, NOW, () => {})), /1 project\(s\) not read/);
  assert.equal(((await store.get<any>("procoreChanges", "9999:77")) as any).gone, undefined, "the failed project's event is left as it was");
  assert.ok(await store.get("procoreChanges", "4242:1"), "the good project was still recorded");
});
