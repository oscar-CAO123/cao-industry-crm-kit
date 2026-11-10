// Settlement workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { register, check, reminders } from "../industries/real-estate/workflows/fulfilment/settlement/index.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/real-estate/workflows/fulfilment/settlement/workflow.json", "utf8")) as WorkflowRecord;
const M1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", M2 = "11111111-2222-4333-8444-555555555555";
const E1 = "12345678-1234-4234-8234-123456789012", E2 = "22222222-3333-4444-8555-666666666666", E_NEW = "87654321-4321-4321-8321-210987654321";
const R1 = "abcdefab-cdef-4abc-8def-abcdefabcdef", U1 = "99999999-8888-4777-8666-555555555555";
const NOW = new Date("2026-11-09T00:00:00Z");

type Hit = { method: string; path: string; search: string; body: any };
let hits: Hit[] = [];
let events: Record<string, any[]> = {};
let byId: Record<string, any> = {};

function fake() {
  hits = [];
  byId = {};
  events = {
    [M1]: [{ id: E1, matter: { id: M1 }, subject: "Settlement", startTime: "2026-12-10T00:00:00", isDeleted: false }],
    [M2]: [],
  };
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, search: u.search, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/matters" && m === "GET") return json({ value: [{ id: M1, status: "Open" }, { id: M2, status: "Open" }] });
      if (p === "/events" && m === "GET") return json({ value: events[u.searchParams.get("MatterId") ?? ""] ?? [] });
      if (p === "/events" && m === "POST") return json({ id: E_NEW });
      if (/^\/events\/[^/]+$/.test(p) && m === "GET") { const ev = byId[p.split("/")[2]]; return ev ? json(ev) : new Response("not found", { status: 404 }); }
      if (/^\/events\/[^/]+$/.test(p) && m === "PUT") return json({ id: E1 });
      if (/^\/events\/[^/]+\/reminders$/.test(p) && m === "POST") return json({ id: R1 });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

const S: any = { business_name: "Test Realty", matter_status: ["Open"], settlement_subject: "Settlement", time_zone: "Australia/Sydney",
  horizon_days: 180, max_matters: 50, remind_days: 3 };
const WITH_REMINDERS: any = { ...S, reminder: { offset_type: "Days", offset_type_id: 1, user_ids: [U1] } };
const ctxFor = (store: MemoryStore, settings: any = S) => context(WF, settings, store, NOW, () => {});
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { SMOKEBALL_ACCESS_TOKEN: "tok", SMOKEBALL_API_KEY: "key", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a live operation cannot be drafted and a draft operation cannot be queued", async () => {
  const ctx = ctxFor(new MemoryStore());
  await assert.rejects(ctx.draft({ platform: "smokeball", op: "UpdateEvent", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "smokeball", op: "CreateEvent", summary: "x", input: {} }), /not a live operation/);
});

test("register reads open matters and their settlement events, and writes nothing", async () => {
  const store = new MemoryStore();
  assert.deepEqual(await register(ctxFor(store)), { matters: 2 });
  assert.ok(hits.every((h) => h.method === "GET"), "only reads");
  assert.match(hits.find((h) => h.path === "/matters")!.search, /Status=Open/);
  const m1 = await store.get<any>("matters", M1);
  assert.deepEqual(m1.events.map((e: any) => [e.event_id, e.date]), [[E1, "2026-12-10"]]);
  assert.deepEqual((await store.get<any>("matters", M2)).events, []);
});

test("check drafts a missing settlement event once and never repeats it", async () => {
  const store = new MemoryStore();
  await store.put("agreed", M2, { matter_id: M2, date: "2026-12-04", source: "signed contract", recorded: NOW.toISOString() });
  const ctx = ctxFor(store);
  await register(ctx);
  assert.deepEqual(await check(ctx), { created: 1, queued: 0, skipped: 0 });
  assert.deepEqual(await check(ctx), { created: 0, queued: 0, skipped: 1 }, "waits for the register to see its own event");
  const creates = hits.filter((h) => h.method === "POST" && h.path === "/events");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].body.matterId, M2);
  assert.equal(creates[0].body.startTime, "2026-12-04T00:00:00");
  assert.equal(creates[0].body.timeZone, "Australia/Sydney");
  assert.deepEqual(creates[0].body.attendees, []);
  assert.equal((await store.get<any>("agreed", M2)).event_id, E_NEW);
  assert.equal(hits.filter((h) => h.method === "PUT").length, 0);
});

test("a changed date is queued for a person, never written, and approval runs the update once", async () => {
  const store = new MemoryStore();
  await store.put("agreed", M1, { matter_id: M1, date: "2026-12-04", source: "conveyancer email", recorded: NOW.toISOString() });
  const ctx = ctxFor(store);
  await register(ctx);
  await check(ctx); await check(ctx);
  assert.equal(writes().length, 0, "nothing written by a cron");
  const pending = Object.values(await store.list<Approval>("approvals"));
  assert.equal(pending.length, 1, "re-runs never queue twice");
  assert.equal(pending[0].status, "pending");
  const ap = await approve(WF, store, pending[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  const put = hits.find((h) => h.method === "PUT")!;
  assert.equal(put.path, `/events/${E1}`);
  assert.equal(put.body.startTime, "2026-12-04T00:00:00");
  await assert.rejects(approve(WF, store, pending[0].id, "owner", NOW), /already done/);
});

test("a date that matches the register queues nothing", async () => {
  const store = new MemoryStore();
  await store.put("agreed", M1, { matter_id: M1, date: "2026-12-10", source: "signed contract", recorded: NOW.toISOString() });
  const ctx = ctxFor(store);
  await register(ctx);
  assert.deepEqual(await check(ctx), { created: 0, queued: 0, skipped: 0 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("a matter with two settlement events is left for a person", async () => {
  const store = new MemoryStore();
  events[M1] = [...events[M1], { id: E2, matter: { id: M1 }, subject: "Settlement", startTime: "2026-12-11T00:00:00", isDeleted: false }];
  await store.put("agreed", M1, { matter_id: M1, date: "2026-12-04", source: "signed contract", recorded: NOW.toISOString() });
  const ctx = ctxFor(store);
  await register(ctx);
  assert.deepEqual(await check(ctx), { created: 0, queued: 0, skipped: 1 });
  assert.equal(writes().length, 0);
});

test("a record with a bad id never reaches a request path", async () => {
  const store = new MemoryStore();
  await store.put("agreed", M1, { matter_id: "../../x", date: "2026-12-04", source: "signed contract", recorded: NOW.toISOString() });
  const ctx = ctxFor(store);
  await register(ctx);
  assert.deepEqual(await check(ctx), { created: 0, queued: 0, skipped: 1 });
  assert.ok(hits.every((h) => !h.path.includes("..")));
});

test("reminders: skipped until the firm sets them, then one per settlement event", async () => {
  const store = new MemoryStore();
  await register(ctxFor(store));
  assert.deepEqual(await reminders(ctxFor(store)), { drafted: 0, off: true });
  assert.equal(hits.filter((h) => h.path.endsWith("/reminders")).length, 0);
  assert.deepEqual(await reminders(ctxFor(store, WITH_REMINDERS)), { drafted: 1, off: false });
  assert.deepEqual(await reminders(ctxFor(store, WITH_REMINDERS)), { drafted: 0, off: false }, "never repeats a reminder");
  const rem = hits.filter((h) => h.path.endsWith("/reminders"));
  assert.equal(rem.length, 1);
  assert.equal(rem[0].path, `/events/${E1}/reminders`);
  assert.equal(rem[0].body.offset, 3);
  assert.deepEqual(rem[0].body.userIds, [U1]);
});

test("an event the register window no longer sees is read by id, and its date change is queued", async () => {
  const store = new MemoryStore();
  events[M1] = [];
  byId[E2] = { id: E2, matter: { id: M1 }, subject: "Settlement", startTime: "2027-03-01T00:00:00", isDeleted: false };
  await store.put("agreed", M1, { matter_id: M1, date: "2026-12-04", source: "signed contract", recorded: NOW.toISOString(), event_id: E2 });
  const ctx = ctxFor(store);
  await register(ctx);
  assert.deepEqual(await check(ctx), { created: 0, queued: 1, skipped: 0 });
  assert.equal(writes().length, 0, "nothing written by a cron");
  assert.equal(hits.filter((h) => h.method === "POST").length, 0, "no second settlement event");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.match(ap.summary, /from 2027-03-01 to 2026-12-04/);
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(hits.find((h) => h.method === "PUT")!.path, `/events/${E2}`);
});

test("a settlement event that was deleted is left for a person, never moved", async () => {
  const store = new MemoryStore();
  events[M1] = [];
  byId[E2] = { id: E2, matter: { id: M1 }, subject: "Settlement", startTime: "2027-03-01T00:00:00", isDeleted: true };
  await store.put("agreed", M1, { matter_id: M1, date: "2026-12-04", source: "signed contract", recorded: NOW.toISOString(), event_id: E2 });
  const ctx = ctxFor(store);
  await register(ctx);
  assert.deepEqual(await check(ctx), { created: 0, queued: 0, skipped: 1 });
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
  assert.equal(writes().length, 0);
});

test("the agreed record's source is stripped of control characters and capped in the approval summary", async () => {
  const store = new MemoryStore();
  await store.put("agreed", M1, { matter_id: M1, date: "2026-12-04", source: "conveyancer\u0007 email\n" + "x".repeat(300), recorded: NOW.toISOString() });
  const ctx = ctxFor(store);
  await register(ctx);
  await check(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.ok(!/[\u0000-\u001f\u007f]/.test(ap.summary), "no control characters");
  assert.ok(ap.summary.length < 260, "source is capped");
});
