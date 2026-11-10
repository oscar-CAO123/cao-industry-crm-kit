// Class timetable workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { CRONS } from "../industries/fitness-beauty/workflows/fulfilment/x-timetable/index.ts";
import { type Settings, type Proposal } from "../industries/fitness-beauty/workflows/fulfilment/x-timetable/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/fitness-beauty/workflows/fulfilment/x-timetable/workflow.json", "utf8")) as WorkflowRecord;
const S: Settings = { family: "class-timetable", booking: "bookeo", lookahead_days: 14, fill_target_percent: 50 };
const NOW = new Date("2026-11-09T00:00:00Z");
const CLASS_AT = "2026-11-12T09:00:00Z";
type Hit = { method: string; path: string; url: string; body: any };
let hits: Hit[] = [];

// Event E1: 8 seats left, 2 booked (20 percent, under target). E2: full, 4 booked (100 percent, not flagged).
const BOOKINGS = [
  { bookingNumber: "B1", productId: "P1", eventId: "E1", startTime: CLASS_AT, canceled: false },
  { bookingNumber: "B2", productId: "P1", eventId: "E1", startTime: CLASS_AT, canceled: false },
  { bookingNumber: "B9", productId: "P1", eventId: "E1", startTime: CLASS_AT, canceled: true },
  { bookingNumber: "B3", productId: "P1", eventId: "E2", startTime: "2026-11-12T18:00:00Z", canceled: false },
  { bookingNumber: "B4", productId: "P1", eventId: "E2", startTime: "2026-11-12T18:00:00Z", canceled: false },
  { bookingNumber: "B5", productId: "P1", eventId: "E2", startTime: "2026-11-12T18:00:00Z", canceled: false },
  { bookingNumber: "B6", productId: "P1", eventId: "E2", startTime: "2026-11-12T18:00:00Z", canceled: false },
];
const SLOTS = [
  { productId: "P1", eventId: "E1", startTime: CLASS_AT, endTime: "2026-11-12T10:00:00Z", numSeatsAvailable: 8 },
  { productId: "P1", eventId: "E2", startTime: "2026-11-12T18:00:00Z", endTime: "2026-11-12T19:00:00Z", numSeatsAvailable: 0 },
];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, url: u.toString(), body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/settings/products")) return json({ info: {}, data: [{ productId: "P1", name: "Reformer 45", type: "fixedCourse" }] });
      if (p.endsWith("/availability/slots")) return json({ info: {}, data: SLOTS });
      if (p.endsWith("/resourceblocks") && m === "GET") return json({ info: {}, data: [] });
      if (p.endsWith("/bookings") && m === "GET") return json({ info: {}, data: BOOKINGS });
      if (p.endsWith("/resourceblocks") && m === "POST") return json({ id: "RB1" });
      if (/\/bookings\/[^/]+$/.test(p) && m === "DELETE") return new Response(null, { status: 204 });
      return new Response("not mapped in the fake", { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { BOOKEO_API_KEY: "k", BOOKEO_SECRET_KEY: "s", KIT_ALLOW_WRITES: "1" });
});

test("crons read and store only: no write reaches the platform", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, S, store, NOW, () => {});
  await CRONS.snapshot(ctx());
  const fill = await CRONS.fillReview(ctx());
  assert.equal(fill.flagged, 1, "only E1 is under the 50 percent target");
  await CRONS.changeQueue(ctx());
  assert.equal(writes().length, 0, "no DELETE or POST before a person approves");
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("a draft op outside draft_ops is refused, and a live op cannot run as a draft", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "bookeo", op: "delete /bookings/{bookingNumber}", input: { params: { bookingNumber: "B1" } }, summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "bookeo", op: "get /bookings", summary: "x" }), /not a live operation/);
});

test("a proposed cancellation is only queued, one approval per five bookings, and approval runs it", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, S, store, NOW, () => {});
  await CRONS.snapshot(ctx());
  await store.put("proposals", "cx1", { id: "cx1", action: "cancel-class", productId: "P1", startTime: CLASS_AT, reason: "Coach unwell" } satisfies Proposal);
  const r = await CRONS.changeQueue(ctx());
  assert.equal(r.queued, 1);
  assert.equal(writes().length, 0, "queued, not run");
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "pending");
  assert.equal(ap.acts.length, 2, "two live bookings (B9 is already cancelled)");
  assert.equal(ap.acts[0].op, "delete /bookings/{bookingNumber}");
  await approve(WF, store, ap.id, "owner", NOW);
  const dels = hits.filter((h) => h.method === "DELETE");
  assert.deepEqual(dels.map((h) => h.path), ["/v2/bookings/B1", "/v2/bookings/B2"]);
  assert.match(dels[0].url, /notifyCustomer=true/);
});

test("re-runs never double-queue the same proposal", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, S, store, NOW, () => {});
  await CRONS.snapshot(ctx());
  await store.put("proposals", "cx1", { id: "cx1", action: "cancel-class", productId: "P1", startTime: CLASS_AT, reason: "Coach unwell" } satisfies Proposal);
  await CRONS.changeQueue(ctx());
  await CRONS.changeQueue(ctx());
  assert.equal(Object.keys(await store.list("approvals")).length, 1);
  await store.put("proposals", "rb1", { id: "rb1", action: "block-room", resourceIds: ["R1"], blockStart: "2026-11-13T06:00:00Z", blockEnd: "2026-11-13T08:00:00Z", reason: "Floor resurfacing" } satisfies Proposal);
  await CRONS.changeQueue(ctx());
  await CRONS.changeQueue(ctx());
  assert.equal(Object.keys(await store.list("approvals")).length, 2, "the room block is queued once");
});

test("a room block is queued and, once approved, posted to Bookeo with the resource ids", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, S, store, NOW, () => {});
  await store.put("proposals", "rb1", { id: "rb1", action: "block-room", resourceIds: ["R1"], blockStart: "2026-11-13T06:00:00Z", blockEnd: "2026-11-13T08:00:00Z", reason: "Floor resurfacing" } satisfies Proposal);
  await CRONS.changeQueue(ctx());
  assert.equal(writes().length, 0);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  await approve(WF, store, ap.id, "owner", NOW);
  const post = hits.find((h) => h.method === "POST");
  assert.equal(post?.path, "/v2/resourceblocks");
  assert.deepEqual(post?.body.resources, [{ id: "R1" }]);
});

test("bad ids and times from a proposal are rejected, never sent to a path or filter", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, S, store, NOW, () => {});
  await store.put("proposals", "bad1", { id: "bad1", action: "cancel-class", productId: "../P1", startTime: CLASS_AT, reason: "x" } satisfies Proposal);
  await store.put("proposals", "bad2", { id: "bad2", action: "block-room", resourceIds: ["R 1"], blockStart: "tomorrow", blockEnd: "later", reason: "x" } satisfies Proposal);
  const r = await CRONS.changeQueue(ctx());
  assert.equal(r.rejected, 2);
  assert.equal(r.queued, 0);
  assert.equal((await store.get<Proposal>("proposals", "bad1"))!.status, "rejected");
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("the Bookeo read follows pageNavigationToken: a booking on a later page is cancelled too", async () => {
  const LAST = "B150", page1 = Array.from({ length: 100 }, (_, i) => ({ bookingNumber: "B" + (i + 1), productId: "P1", eventId: "E9", startTime: "2026-11-12T18:00:00Z", canceled: false }));
  const tokens: (string | null)[] = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any) => {
      const u = new URL(String(url)), p = u.pathname;
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p.endsWith("/settings/products")) return json({ info: {}, data: [{ productId: "P1", name: "Reformer 45" }] });
      if (p.endsWith("/availability/slots") || p.endsWith("/resourceblocks")) return json({ info: {}, data: [] });
      if (p.endsWith("/bookings")) {
        const tok = u.searchParams.get("pageNavigationToken");
        tokens.push(tok);
        if (!tok) return json({ info: { pageNavigationToken: "NEXT1" }, data: page1 });
        return json({ info: {}, data: [{ bookingNumber: LAST, productId: "P1", startTime: CLASS_AT, canceled: false }] });
      }
      return new Response("not mapped", { status: 404 });
    }) as any,
  });
  const store = new MemoryStore(), ctx = () => context(WF, S, store, NOW, () => {});
  await CRONS.snapshot(ctx());
  assert.deepEqual(tokens, [null, "NEXT1"], "the second page is asked for by its token");
  await store.put("proposals", "cx2", { id: "cx2", action: "cancel-class", productId: "P1", startTime: CLASS_AT, reason: "Coach unwell" } satisfies Proposal);
  await CRONS.changeQueue(ctx());
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.deepEqual(ap.acts.map((a) => a.input?.params?.bookingNumber), [LAST], "the booking on page two is in the cancellation");
});

test("a cancel proposal stays pending while there is no snapshot or the snapshot is stale", async () => {
  const store = new MemoryStore();
  await store.put("proposals", "cx3", { id: "cx3", action: "cancel-class", productId: "P1", startTime: CLASS_AT, reason: "Coach unwell", status: "pending" } satisfies Proposal);
  await CRONS.changeQueue(context(WF, S, store, NOW, () => {}));
  assert.equal((await store.get<Proposal>("proposals", "cx3"))!.status, "pending", "no snapshot yet: not marked no-bookings");
  await CRONS.snapshot(context(WF, S, store, NOW, () => {}));
  await CRONS.changeQueue(context(WF, S, store, new Date(NOW.getTime() + 2 * 36e5), () => {}));
  assert.equal((await store.get<Proposal>("proposals", "cx3"))!.status, "pending", "a two-hour-old snapshot is not trusted");
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
  assert.equal((await CRONS.changeQueue(context(WF, S, store, NOW, () => {}))).queued, 1, "a fresh snapshot queues it");
});

test("a proposal start time in another format still matches the booking", async () => {
  const store = new MemoryStore(), ctx = () => context(WF, S, store, NOW, () => {});
  await CRONS.snapshot(ctx());
  await store.put("proposals", "cx4", { id: "cx4", action: "cancel-class", productId: "P1", startTime: "2026-11-12T09:00:00.000Z", reason: "Coach unwell" } satisfies Proposal);
  assert.equal((await CRONS.changeQueue(ctx())).queued, 1);
  assert.equal((await store.get<Proposal>("proposals", "cx4"))!.status, "queued");
});

