// Labour-by-person workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import * as wf from "../industries/construction/workflows/finance-admin/x-labour/index.ts";
import { shiftsFrom, type StaffEvent } from "../industries/construction/workflows/finance-admin/x-labour/adapters/servicem8.ts";

const DIR = "industries/construction/workflows/finance-admin/x-labour";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const CAL = "11111111-2222-4333-8444-555555555555", RATE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const STAFF_A = "10000000-0000-4000-8000-00000000000a", STAFF_B = "10000000-0000-4000-8000-00000000000b";
const STAFF_C = "10000000-0000-4000-8000-00000000000c", STAFF_D = "10000000-0000-4000-8000-00000000000d";
const EMP_A = "20000000-0000-4000-8000-00000000000a", EMP_B = "20000000-0000-4000-8000-00000000000b", EMP_C = "20000000-0000-4000-8000-00000000000c";
const NOW = new Date("2026-11-08T00:00:00Z");
const S: any = {
  pay_period: { start: "2026-11-02", end: "2026-11-15", payment_date: "2026-11-20" }, payroll_calendar_id: CAL,
  employee_map: { [STAFF_A]: EMP_A, [STAFF_B]: EMP_B, [STAFF_C]: EMP_C }, earnings_rate_id: RATE, max_hours_per_shift: 12,
};

const U = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ev = (n: number, staff: string, timestamp: string, event_name: string) => ({ uuid: U(n), staff_uuid: staff, timestamp, event_name, active: 1 });
const gid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let events: Record<string, unknown>[] = [];
let xts: Record<string, { timesheetID: string; employeeID: string; status: string; totalHours: number; lines: any[] }> = {};
let seq = 0, failLines = 0;

/** The week: A works an 8 hour day with a 30 minute lunch; B works 10 and 6 hours, then a 14 hour day that is held; C is still clocked on;
 *  D has no Xero employee. */
function week(): Record<string, unknown>[] {
  return [
    ev(1, STAFF_A, "2026-11-02 07:00:00", "CLOCK_ON"), ev(2, STAFF_A, "2026-11-02 11:00:00", "LUNCH_START"),
    ev(3, STAFF_A, "2026-11-02 11:30:00", "LUNCH_END"), ev(4, STAFF_A, "2026-11-02 15:30:00", "CLOCK_OFF"),
    ev(5, STAFF_B, "2026-11-02 06:00:00", "CLOCK_ON"), ev(6, STAFF_B, "2026-11-02 16:00:00", "CLOCK_OFF"),
    ev(7, STAFF_B, "2026-11-03 06:00:00", "CLOCK_ON"), ev(8, STAFF_B, "2026-11-03 12:00:00", "CLOCK_OFF"),
    ev(9, STAFF_B, "2026-11-04 06:00:00", "CLOCK_ON"), ev(10, STAFF_B, "2026-11-04 20:00:00", "CLOCK_OFF"),
    ev(11, STAFF_C, "2026-11-04 07:00:00", "CLOCK_ON"),
    ev(12, STAFF_D, "2026-11-02 07:00:00", "CLOCK_ON"), ev(13, STAFF_D, "2026-11-02 15:00:00", "CLOCK_OFF"),
  ];
}

function fake() {
  hits = []; seq = 0; xts = {}; failLines = 0; events = week();
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // ServiceM8: staff clock events (the fake returns the whole week; the filter is not re-applied here)
      if (p.endsWith("/stafftimeevent.json")) return json(events);
      // Xero Payroll AU v2: timesheets
      if (p.endsWith("/Timesheets") && m === "GET") {
        const status = u.searchParams.get("status");
        const rows = Object.values(xts).filter((t) => !status || t.status === status)
          .map((t) => ({ timesheetID: t.timesheetID, employeeID: t.employeeID, status: t.status, totalHours: t.totalHours }));
        return json({ timesheets: rows, pagination: { pageCount: 1 } });
      }
      if (p.endsWith("/Timesheets") && m === "POST") {
        const id = gid(++seq), lines = body.timesheetLines ?? [];
        xts[id] = { timesheetID: id, employeeID: body.employeeID, status: "Draft", totalHours: lines.reduce((a: number, l: any) => a + Number(l.numberOfUnits), 0), lines: [...lines] };
        return json({ timesheet: { timesheetID: id, status: "Draft" } });
      }
      const lines = p.match(/\/Timesheets\/([^/]+)\/Lines$/);
      if (lines && m === "POST") {
        if (failLines-- > 0) return new Response("{}", { status: 500 });
        const t = xts[lines[1]];
        if (!t) return new Response("{}", { status: 404 });
        t.lines.push(body); t.totalHours += Number(body.numberOfUnits);
        return json({ timesheetLine: { timesheetLineID: gid(++seq) } });
      }
      const ap = p.match(/\/Timesheets\/([^/]+)\/Approve$/);
      if (ap && m === "POST") {
        const t = xts[ap[1]];
        if (!t) return new Response("{}", { status: 404 });
        t.status = "Approved";
        return json({ timesheet: { timesheetID: t.timesheetID, status: "Approved" } });
      }
      const one = p.match(/\/Timesheets\/([^/]+)$/);
      if (one && m === "GET") { const t = xts[one[1]]; return t ? json({ timesheet: { timesheetID: t.timesheetID, employeeID: t.employeeID, status: t.status, totalHours: t.totalHours } }) : new Response("{}", { status: 404 }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

const isLive = (h: Hit) => h.method === "POST" && /\/Timesheets\/[^/]+\/Approve$/.test(h.path);
const count = (pred: (h: Hit) => boolean) => hits.filter(pred).length;
const createdSheets = () => count((h) => h.method === "POST" && h.path.endsWith("/Timesheets"));
const lineHits = () => count((h) => /\/Lines$/.test(h.path));
const ctxFor = (store: MemoryStore) => context(WF, S, store, NOW, () => {});
const pendingApprovals = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, {
    SERVICEM8_API_KEY: "s8", XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1",
  });
});

test("record: every operation is in the kit, no op is both draft and live, each cron is exported, and a cron cannot cross the line", async () => {
  const kit = (platform: string) => new Set((JSON.parse(fs.readFileSync(`core/sdk/platforms/${platform}/ops.json`, "utf8")) as { id: string }[]).map((o) => o.id));
  for (const lists of [WF.draft_ops, WF.live_ops] as Record<string, string[]>[]) {
    for (const [platform, ids] of Object.entries(lists)) for (const id of ids) assert.ok(kit(platform).has(id), `${platform} ${id} is in the kit`);
  }
  for (const [platform, ids] of Object.entries(WF.live_ops)) for (const id of ids) assert.ok(!(WF.draft_ops[platform] ?? []).includes(id), `${id} is not also draft`);
  for (const c of WF.crons) assert.ok(typeof (wf.CRONS as Record<string, unknown>)[c.entry] === "function", `${c.entry} is exported`);
  assert.equal(new Set(WF.crons.map((c) => c.name)).size, WF.crons.length);
  const ctx = ctxFor(new MemoryStore());
  await assert.rejects(ctx.draft({ platform: "xero", op: "payroll-au-v2.approveTimesheet", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "payroll-au-v2.createTimesheet", summary: "x" }), /not a live operation/);
});

test("shiftsFrom: lunch is taken off, a clock-on still open holds the person, and a broken pair writes nothing for that person", () => {
  const e = (n: number, staff: string, timestamp: string, event: string): StaffEvent => ({ uuid: U(n), staff, timestamp, event });
  const ok = shiftsFrom([e(1, STAFF_A, "2026-11-02 07:00:00", "CLOCK_ON"), e(2, STAFF_A, "2026-11-02 11:00:00", "LUNCH_START"),
    e(3, STAFF_A, "2026-11-02 11:30:00", "LUNCH_END"), e(4, STAFF_A, "2026-11-02 15:30:00", "CLOCK_OFF")]);
  assert.deepEqual(ok.shifts, [{ key: U(1), staff: STAFF_A, date: "2026-11-02", hours: 8 }], "8.5 hours on the clock less a 30 minute lunch");
  const open = shiftsFrom([e(5, STAFF_C, "2026-11-04 07:00:00", "CLOCK_ON")]);
  assert.deepEqual(open.open, [STAFF_C]);
  assert.equal(open.shifts.length, 0);
  const broken = shiftsFrom([e(6, STAFF_B, "2026-11-02 06:00:00", "CLOCK_ON"), e(7, STAFF_B, "2026-11-02 08:00:00", "CLOCK_ON"),
    e(8, STAFF_B, "2026-11-02 15:00:00", "CLOCK_OFF"), e(9, STAFF_D, "2026-11-03 06:00:00", "CLOCK_ON"), e(10, STAFF_D, "2026-11-03 14:00:00", "CLOCK_OFF")]);
  assert.deepEqual(broken.problem, [STAFF_B], "a second clock-on with no clock-off is a problem");
  assert.deepEqual(broken.shifts, [{ key: U(9), staff: STAFF_D, date: "2026-11-03", hours: 8 }], "the clean person is still paired");
});

test("mirror: each person gets one draft timesheet, a shift is written once, over-limit shifts are held, nothing is approved", async () => {
  const store = new MemoryStore(), ctx = ctxFor(store);
  assert.deepEqual(await wf.mirror(ctx), { mirrored: 3, flagged: 1, unmapped: 1, failed: 0, held: 2 });
  assert.equal(createdSheets(), 2, "one draft timesheet for each of the two mapped people who worked");
  assert.equal(lineHits(), 1, "B's second day is one line on B's existing timesheet");
  const sheetA = Object.values(xts).find((t) => t.employeeID === EMP_A)!;
  assert.equal(sheetA.totalHours, 8);
  assert.deepEqual(sheetA.lines[0], { date: "2026-11-02", earningsRateID: RATE, numberOfUnits: 8 });
  assert.equal(Object.values(xts).find((t) => t.employeeID === EMP_B)!.totalHours, 16, "the 14 hour day is held out of the timesheet");
  assert.equal(count(isLive), 0, "mirror approves nothing");
  assert.equal((await store.get<{ state: string }>("shifts", `shift:${U(9)}`))!.state, "flagged");
  assert.deepEqual(await wf.mirror(ctx), { mirrored: 0, flagged: 0, unmapped: 1, failed: 0, held: 2 }, "a second run writes nothing new");
  assert.equal(createdSheets(), 2);
  assert.equal(lineHits(), 1);
});

test("mirror: a write with an unclear outcome is marked needs-check, holds the person, and is never sent again on its own", async () => {
  events = [ev(1, STAFF_A, "2026-11-02 07:00:00", "CLOCK_ON"), ev(2, STAFF_A, "2026-11-02 15:00:00", "CLOCK_OFF")];
  const store = new MemoryStore(), ctx = ctxFor(store);
  await wf.mirror(ctx);
  events = [...events, ev(3, STAFF_A, "2026-11-03 07:00:00", "CLOCK_ON"), ev(4, STAFF_A, "2026-11-03 15:00:00", "CLOCK_OFF")];
  failLines = 1;
  assert.deepEqual(await wf.mirror(ctx), { mirrored: 0, flagged: 0, unmapped: 0, failed: 1, held: 1 });
  assert.equal((await store.get<{ state: string }>("shifts", `shift:${U(3)}`))!.state, "needs-check");
  assert.deepEqual(await wf.mirror(ctx), { mirrored: 0, flagged: 0, unmapped: 0, failed: 0, held: 1 });
  assert.equal(lineHits(), 1, "the failed line was sent once and not again");
  assert.deepEqual(await wf.approve(ctx), { queued: 0, held: 1 }, "the person with the failed line is not queued for approval");
});

test("approve: each clean Draft timesheet is queued once, held people are not, and nothing runs until a person approves", async () => {
  const store = new MemoryStore(), ctx = ctxFor(store);
  assert.deepEqual(await wf.approve(ctx), { waiting: "mirror has not run for this period" }, "no mirror yet, nothing queued");
  assert.equal((await pendingApprovals(store)).length, 0);
  await wf.mirror(ctx);
  assert.deepEqual(await wf.approve(ctx), { queued: 1, held: 1 });
  assert.deepEqual(await wf.approve(ctxFor(store)), { queued: 1, held: 1 }, "a re-run never queues the same timesheet twice");
  const queued = await pendingApprovals(store);
  assert.equal(queued.length, 1);
  assert.equal(count(isLive), 0, "no approval ran on its own");
  const done = await approve(WF, store, queued[0].id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(count(isLive), 1, "the approved timesheet is approved once");
  assert.equal(Object.values(xts).find((t) => t.employeeID === EMP_A)!.status, "Approved");
  assert.equal(Object.values(xts).find((t) => t.employeeID === EMP_B)!.status, "Draft", "the held person stays in draft");
});

test("mirror: a queued approval is withdrawn once its person is held, so partial hours cannot be approved", async () => {
  events = [ev(31, STAFF_A, "2026-11-02 07:00:00", "CLOCK_ON"), ev(32, STAFF_A, "2026-11-02 15:00:00", "CLOCK_OFF"),
    ev(33, STAFF_B, "2026-11-02 06:00:00", "CLOCK_ON"), ev(34, STAFF_B, "2026-11-02 14:00:00", "CLOCK_OFF")];
  const store = new MemoryStore(), ctx = ctxFor(store);
  assert.deepEqual(await wf.mirror(ctx), { mirrored: 2, flagged: 0, unmapped: 0, failed: 0, held: 0 });
  assert.deepEqual(await wf.approve(ctx), { queued: 2, held: 0 });
  events = [...events, ev(35, STAFF_A, "2026-11-03 07:00:00", "CLOCK_ON")];
  await wf.mirror(ctx);
  const all = Object.values(await store.list<Approval>("approvals"));
  const a = all.find((x) => x.summary.includes(EMP_A))!, b = all.find((x) => x.summary.includes(EMP_B))!;
  assert.equal(a.status, "rejected", "A is clocked on again, so A's queued approval is withdrawn");
  assert.equal(b.status, "pending", "B is still clean and stays queued");
  await assert.rejects(approve(WF, store, a.id, "owner", NOW), /already rejected/);
  assert.equal(count(isLive), 0, "nothing approved");
});

test("mirror: a timesheet a crashed run created in Xero is reused, never duplicated", async () => {
  events = [ev(21, STAFF_A, "2026-11-02 07:00:00", "CLOCK_ON"), ev(22, STAFF_A, "2026-11-02 15:00:00", "CLOCK_OFF")];
  const store = new MemoryStore(), ctx = ctxFor(store);
  await wf.mirror(ctx);
  assert.equal(createdSheets(), 1);
  for (const k of Object.keys(await store.list("xts"))) await store.put("xts", k, undefined);
  events = [...events, ev(23, STAFF_A, "2026-11-03 07:00:00", "CLOCK_ON"), ev(24, STAFF_A, "2026-11-03 15:00:00", "CLOCK_OFF")];
  assert.deepEqual(await wf.mirror(ctx), { mirrored: 1, flagged: 0, unmapped: 0, failed: 0, held: 0 });
  assert.equal(createdSheets(), 1, "no second draft timesheet for the same person and period");
  assert.equal(Object.values(xts).find((t) => t.employeeID === EMP_A)!.totalHours, 16, "the new shift is a line on the existing draft");
});

test("holds: mirror writes each held person to the shared timesheet-holds record, with the pay period, and keeps none under the old name", async () => {
  const store = new MemoryStore(), ctx = ctxFor(store);
  await wf.mirror(ctx);
  const h = await store.get<{ employees: string[]; start: string; end: string }>("timesheet-holds", "period:2026-11-02");
  assert.ok(h, "the hold is in the shared namespace");
  assert.deepEqual([...h.employees].sort(), [EMP_B, EMP_C].sort(), "B has a shift over the limit and C is still clocked on");
  assert.equal(h.start, "2026-11-02");
  assert.equal(h.end, "2026-11-15");
  assert.equal(await store.get("holds", "period:2026-11-02"), undefined, "no hold is kept under the old private name");
});

test("approve: an unchanged Draft timesheet is re-read and approved once", async () => {
  const store = new MemoryStore(), ctx = ctxFor(store);
  await wf.mirror(ctx);
  await wf.approve(ctx);
  const [ap] = await pendingApprovals(store);
  assert.equal((await approve(WF, store, ap.id, "owner", NOW)).status, "done");
  assert.equal(count((h) => h.method === "GET" && /\/Timesheets\/[^/]+$/.test(h.path)), 1, "the timesheet was re-read just before the approval");
  assert.equal(count(isLive), 1, "approved once");
});

test("approve: a timesheet that gained hours after it was queued is closed and not approved", async () => {
  events = [ev(41, STAFF_A, "2026-11-02 07:00:00", "CLOCK_ON"), ev(42, STAFF_A, "2026-11-02 15:00:00", "CLOCK_OFF")];
  const store = new MemoryStore(), ctx = ctxFor(store);
  await wf.mirror(ctx);
  await wf.approve(ctx);
  const [ap] = await pendingApprovals(store);
  events = [...events, ev(43, STAFF_A, "2026-11-03 07:00:00", "CLOCK_ON"), ev(44, STAFF_A, "2026-11-03 15:00:00", "CLOCK_OFF")];
  await wf.mirror(ctx);                                        // the second day lands as a line: 16 hours now
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "rejected");
  assert.equal(done.decided_by, "check");
  assert.match(done.error ?? "", /the record changed after this was queued .*nothing was sent/);
  assert.equal(count(isLive), 0, "nothing approved");
  assert.equal(Object.values(xts)[0].status, "Draft");
});

test("approve: a closed timesheet is queued again once its hours settle, and never twice", async () => {
  events = [ev(51, STAFF_A, "2026-11-02 07:00:00", "CLOCK_ON"), ev(52, STAFF_A, "2026-11-02 15:00:00", "CLOCK_OFF")];
  const store = new MemoryStore(), ctx = ctxFor(store);
  await wf.mirror(ctx);
  await wf.approve(ctx);
  const [first] = await pendingApprovals(store);
  events = [...events, ev(53, STAFF_A, "2026-11-03 07:00:00", "CLOCK_ON"), ev(54, STAFF_A, "2026-11-03 15:00:00", "CLOCK_OFF")];
  await wf.mirror(ctx);
  assert.equal((await approve(WF, store, first.id, "owner", NOW)).status, "rejected");
  await wf.approve(ctx);
  await wf.approve(ctx);
  const pending = await pendingApprovals(store);
  assert.equal(pending.length, 1, "one fresh approval for the 16 hours, not one per run");
  assert.notEqual(pending[0].id, first.id);
  assert.equal((await approve(WF, store, pending[0].id, "owner", NOW)).status, "done");
  assert.equal(count(isLive), 1);
});
