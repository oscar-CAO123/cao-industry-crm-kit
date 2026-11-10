// Automatic time capture workflow tests. Every request goes to a fake network: no test reaches a real Clio account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval, type Act } from "../core/workflows/runtime.ts";
import { capture, matters, entries, CRONS } from "../industries/professional-services/workflows/finance-admin/x-autotime/index.ts";
import { clioId, day, hours } from "../industries/professional-services/workflows/finance-admin/x-autotime/adapters/clio.ts";
import type { Request, Settings } from "../industries/professional-services/workflows/finance-admin/x-autotime/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/professional-services/workflows/finance-admin/x-autotime/workflow.json", "utf8")) as WorkflowRecord;
const S: Settings = { business_name: "Test Law", clio_user_id: 42 };
const NOW = new Date("2026-11-09T02:00:00Z");
const TODAY = "2026-11-09";

type Hit = { method: string; path: string; query: string; body: any };
let hits: Hit[] = [];
let timerStatus = 200;

function fake() {
  hits = []; timerStatus = 200;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams.toString(), body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (p.endsWith("/api/v4/activities.json") && m === "GET") return json({ data: [
        { id: 1, type: "TimeEntry", date: TODAY, quantity_in_hours: 1.5, note: "Client call", matter: { id: 77 }, non_billable: false },
        { id: 2, type: "TimeEntry", date: TODAY, quantity_in_hours: 0.5, note: null, matter: null, non_billable: false } ] });
      if (p.endsWith("/api/v4/activities.json") && m === "POST") return json({ data: { id: 555 } }, 201);
      if (p.endsWith("/api/v4/timer.json")) return timerStatus === 404 ? json({ error: "not found" }, 404)
        : json({ data: { id: 9, start_time: "2026-11-09T01:00:00Z", elapsed_time: 3600 } });
      if (p.endsWith("/api/v4/billable_matters.json")) return json({ data: [{ id: 77, display_number: "00077-Smith", description: "Smith v Jones" }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { CLIO_ACCESS_TOKEN: "t", KIT_ALLOW_WRITES: "1" });
});

test("runtime: a cron cannot draft a live operation and cannot queue a read", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "clio", op: "openapi.Activity#create", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "clio", op: "openapi.Activity#index", summary: "x" }), /not a live operation/);
});

test("the crons are registered under their entry names", () => {
  assert.deepEqual(Object.keys(CRONS).sort(), ["capture", "entries", "matters"]);
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), ["capture", "entries", "matters"]);
});

test("capture and matters only read: they flag an entry with no matter or no note, once", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await capture(ctx), { entries: 2, timer_running: true, flagged: 2 });
  assert.equal(writes().length, 0, "nothing written by a read cron");
  const idx = hits.find((h) => h.path.endsWith("/activities.json"))!;
  assert.match(idx.query, /user_id=42/);
  assert.match(idx.query, /type=TimeEntry/);
  assert.match(idx.query, new RegExp(`start_date=${TODAY}`));
  assert.deepEqual(await capture(ctx), { entries: 2, timer_running: true, flagged: 0 }, "a flag is raised once");
  assert.deepEqual(await matters(ctx), { matters: 1 });
  assert.equal(writes().length, 0);
});

test("no running timer is not an error", async () => {
  timerStatus = 404;
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await capture(ctx), { entries: 2, timer_running: false, flagged: 2 });
});

test("a time entry a person records is queued, never written, and re-runs never queue it twice", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await matters(ctx);
  await store.put("requests", "r1", { id: "r1", matter_id: 77, date: TODAY, hours: 1.5, note: "Client call", status: "requested", requested_at: NOW.toISOString() } satisfies Request);
  assert.deepEqual(await entries(ctx), { queued: 1, parked: 0 });
  assert.equal(writes().length, 0, "nothing written by a cron");
  assert.deepEqual(await entries(ctx), { queued: 0, parked: 0 });
  const approvals = Object.values(await store.list<Approval>("approvals"));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].acts[0].op, "openapi.Activity#create");
  // The approver must see the exact value Clio will book: hours as entered, and the seconds quantity sent.
  assert.match(approvals[0].summary, /log 1\.5 h \(Clio quantity 5400 seconds\)/);
});

test("capture keeps ids, dates and flags only, never the note text", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await capture(ctx);
  const saved = JSON.stringify(await store.list("captured"));
  assert.doesNotMatch(saved, /Client call/, "note text must not be stored");
  assert.match(saved, /"has_note":true/);
  assert.match(saved, /"matter_id":77/);
});

test("an approved entry reaches Clio once, with hours sent as seconds on the fee earner's matter", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await matters(ctx);
  await store.put("requests", "r1", { id: "r1", matter_id: 77, date: TODAY, hours: 1.5, note: "Client call", status: "requested", requested_at: NOW.toISOString() } satisfies Request);
  await entries(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  const post = writes().find((h) => h.method === "POST" && h.path.endsWith("/api/v4/activities.json"))!;
  assert.deepEqual(post.body, { data: { type: "TimeEntry", date: TODAY, quantity: 5400, matter: { id: 77 }, user: { id: 42 }, non_billable: false, note: "Client call" } });
  assert.deepEqual(done.results?.[0].ref, { id: "555" });
  await assert.rejects(approve(WF, store, ap.id, "owner"), /already done/);
  assert.equal(writes().length, 1);
});

test("a request on a matter that is not open is parked, not queued", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await matters(ctx);
  await store.put("requests", "r2", { id: "r2", matter_id: 999, date: TODAY, hours: 0.5, status: "requested", requested_at: NOW.toISOString() } satisfies Request);
  assert.deepEqual(await entries(ctx), { queued: 0, parked: 1 });
  const r2 = await store.get<Request>("requests", "r2");
  assert.equal(r2?.status, "needs-check");
  assert.match(r2?.reason_parked ?? "", /not one of the open matters/);
  assert.equal(Object.keys(await store.list("approvals")).length, 0);
});

test("with writes blocked the approved entry fails and nothing reaches Clio", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await matters(ctx);
  await store.put("requests", "r1", { id: "r1", matter_id: 77, date: TODAY, hours: 1, status: "requested", requested_at: NOW.toISOString() } satisfies Request);
  await entries(ctx);
  process.env.KIT_ALLOW_WRITES = "0";
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const failed = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(failed.status, "failed");
  assert.equal(writes().length, 0);
});

test("the adapter refuses bad ids, dates and hours before they reach a body", () => {
  assert.throws(() => clioId("77; drop", "matter"), /bad matter/);
  assert.throws(() => day("2026-13-40"), /bad date/);
  assert.throws(() => hours(0), /bad hours/);
  assert.throws(() => hours(25), /bad hours/);
  assert.equal(hours(1.25), 1.25);
});

test("every cron act named in the workflow record maps to a real operation", () => {
  const acts: Act[] = [{ platform: "clio", op: "openapi.Activity#create", summary: "" }];
  for (const a of acts) assert.ok(WF.live_ops[a.platform]?.includes(a.op));
  for (const op of WF.draft_ops.clio) assert.ok(op.startsWith("openapi."));
});
