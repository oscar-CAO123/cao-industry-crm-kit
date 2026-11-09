// Client timeline workflow tests. Every request goes to a fake network: no test reaches a real GoHighLevel account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { timeline, handOff, checkIn, CRONS } from "../industries/financial-services/workflows/customer-success/add-timeline/index.ts";

const DIR = "industries/financial-services/workflows/customer-success/add-timeline";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const C = "abcdef1234567890ABCD", O = "opp0123456789ABCDEFG", U = "usr0123456789ABCDEFG", U2 = "usr9876543210ZYXWVUT";
const NOW = new Date("2026-11-09T00:00:00Z");
const SETTINGS: any = { platform: "gohighlevel", gohighlevel: { owner_user_id: U }, watch: [{ contact_id: C, opportunity_id: O }], check_in_days: 30 };

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === `/contacts/${C}/notes` && m === "GET") return json({ notes: [
        { id: "n1", body: "Call: wants a refinance quote", dateAdded: "2026-11-05T01:00:00.000Z", userId: U },
        { id: "n0", body: "Intro email sent", dateAdded: "2026-10-20T01:00:00.000Z", userId: U }], hasMore: false });
      if (p === `/contacts/${C}/tasks` && m === "GET") return json({ tasks: [{ id: "t1", title: "Send rate sheet", dueDate: "2026-11-12T00:00:00.000Z", completed: false, assignedTo: U }] });
      if (p === `/contacts/${C}/notes` && m === "POST") return json({ note: { id: "nn1" } });
      if (p === `/contacts/${C}/tasks` && m === "POST") return json({ task: { id: "tt1" } });
      if (p === `/opportunities/${O}/followers` && m === "POST") return json({ followers: [U2] });
      if (p === `/opportunities/${O}/status` && m === "PUT") return json({ opportunity: { id: O, status: "won" } });
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  Object.assign(process.env, { GHL_ACCESS_TOKEN: "test-token", KIT_ALLOW_WRITES: "1" });
  fake();
});

const handoff = (over: Record<string, unknown> = {}) => ({
  id: "h1", contact_id: C, opportunity_id: O, to_user_id: U2, summary: "Refinance: client wants a fixed rate, call Thursday",
  status: "new", created: NOW.toISOString(), ...over,
});

test("the workflow record lists the crons it registers, and every one has an entry", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), WF.crons.map((c) => c.entry).sort());
});

test("timeline reads notes and tasks, keeps one timeline per client, and writes nothing", async () => {
  const store = new MemoryStore();
  await timeline(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal(writes().length, 0, "no write reaches the client record");
  const tl = (await store.get<any>("timeline", C))!;
  assert.equal(tl.events.length, 3);
  assert.equal(tl.last_activity, "2026-11-05T01:00:00.000Z");
});

test("hand-off drafts a note, a task and a follower, and only queues the status change", async () => {
  const store = new MemoryStore();
  await store.put("handoffs", "h1", handoff({ status_change: "won" }));
  const r = await handOff(context(WF, SETTINGS, store, NOW, () => {}));
  assert.deepEqual(r, { drafted: 1, queued: 1 });
  assert.ok(hits.some((h) => h.method === "POST" && h.path === `/contacts/${C}/notes`));
  assert.ok(hits.some((h) => h.method === "POST" && h.path === `/contacts/${C}/tasks` && h.body.assignedTo === U2));
  assert.ok(hits.some((h) => h.path === `/opportunities/${O}/followers` && h.body.followers[0] === U2));
  assert.equal(hits.filter((h) => h.method === "PUT").length, 0, "the status change is not sent by a cron");
  const aps = Object.values(await store.list<Approval>("approvals"));
  assert.equal(aps.length, 1);
  assert.equal(aps[0].status, "pending");
  assert.equal(aps[0].acts[0].op, "opportunities.update-opportunity-status");
});

test("approving the queued status change runs it once, with the status in the body", async () => {
  const store = new MemoryStore();
  await store.put("handoffs", "h1", handoff({ status_change: "won" }));
  await handOff(context(WF, SETTINGS, store, NOW, () => {}));
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const put = hits.find((h) => h.method === "PUT");
  assert.equal(put?.path, `/opportunities/${O}/status`);
  assert.equal(put?.body.status, "won");
});

test("a re-run never repeats a note, task, follower or queued status change", async () => {
  const store = new MemoryStore();
  await store.put("handoffs", "h1", handoff({ status_change: "won" }));
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await handOff(ctx);
  const first = writes().length;
  await handOff(ctx);
  assert.equal(writes().length, first, "nothing written on the second run");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 1);
});

test("a lost hand-off without a lost reason is held for a person and not queued", async () => {
  const store = new MemoryStore();
  await store.put("handoffs", "h1", handoff({ status_change: "lost" }));
  await handOff(context(WF, SETTINGS, store, NOW, () => {}));
  assert.equal((await store.get<any>("handoffs", "h1")).status, "needs-check");
  assert.equal(Object.keys(await store.list<Approval>("approvals")).length, 0);
});

test("a hand-off with a malformed id is held for a person and does not stop the later hand-offs", async () => {
  const store = new MemoryStore();
  await store.put("handoffs", "a-bad", handoff({ id: "a-bad", to_user_id: "../../etc" }));
  await store.put("handoffs", "b-good", handoff({ id: "b-good" }));
  const r = await handOff(context(WF, SETTINGS, store, NOW, () => {}));
  assert.deepEqual(r, { drafted: 1, queued: 0 }, "the good hand-off still runs");
  assert.equal((await store.get<any>("handoffs", "a-bad")).status, "needs-check");
  assert.equal((await store.get<any>("handoffs", "b-good")).status, "drafted");
  assert.ok(hits.some((h) => h.method === "POST" && h.path === `/contacts/${C}/notes`), "the good hand-off wrote its note");
  assert.equal(hits.filter((h) => h.method === "POST" && h.path === `/contacts/${C}/notes`).length, 1, "the malformed one wrote nothing");
});

test("check-in creates one follow-up task for a quiet client, and not again in the same period", async () => {
  const store = new MemoryStore();
  await store.put("timeline", C, { contact_id: C, events: [], last_activity: "2026-09-01T00:00:00.000Z", updated: NOW.toISOString() });
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await checkIn(ctx), { tasks: 1 });
  assert.deepEqual(await checkIn(ctx), { tasks: 0 });
  const tasks = hits.filter((h) => h.method === "POST" && h.path === `/contacts/${C}/tasks`);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].body.assignedTo, U);
  assert.equal(tasks[0].body.completed, false);
});

test("a client with recent activity gets no check-in task", async () => {
  const store = new MemoryStore();
  await store.put("timeline", C, { contact_id: C, events: [], last_activity: "2026-11-05T01:00:00.000Z", updated: NOW.toISOString() });
  assert.deepEqual(await checkIn(context(WF, SETTINGS, store, NOW, () => {})), { tasks: 0 });
  assert.equal(writes().length, 0);
});

test("a bad id is refused before any request leaves", async () => {
  const bad = { ...SETTINGS, watch: [{ contact_id: "../../etc" }] };
  await assert.rejects(timeline(context(WF, bad, new MemoryStore(), NOW, () => {})), /bad contact id/);
  assert.equal(hits.length, 0);
});

test("writes are blocked without KIT_ALLOW_WRITES, before any socket opens", async () => {
  process.env.KIT_ALLOW_WRITES = "0";
  const store = new MemoryStore();
  await store.put("handoffs", "h1", handoff());
  await assert.rejects(handOff(context(WF, SETTINGS, store, NOW, () => {})), WriteBlocked);
  assert.equal(hits.filter((h) => h.method === "POST").length, 0);
});
