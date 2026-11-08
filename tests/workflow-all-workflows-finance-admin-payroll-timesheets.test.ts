// Payroll-timesheets workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import * as wf from "../industries/all/workflows/finance-admin/payroll-timesheets/index.ts";

const DIR = "industries/all/workflows/finance-admin/payroll-timesheets";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const CAL = "11111111-2222-4333-8444-555555555555", RATE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EMP_A = "10000000-0000-4000-8000-00000000000a", EMP_B = "10000000-0000-4000-8000-00000000000b", EMP_C = "10000000-0000-4000-8000-00000000000c";
const NOW = new Date("2026-11-08T00:00:00Z");
const S: any = {
  timesheets: "deputy", pay_period: { start: "2026-11-02", end: "2026-11-15", payment_date: "2026-11-20" }, payroll_calendar_id: CAL,
  employee_map: { "101": EMP_A, "102": EMP_B, "103": EMP_C }, earnings_rate_id: RATE, max_hours_per_shift: 12,
};

type Hit = { method: string; path: string; body: any };
let hits: Hit[] = [];
let shifts: Record<string, unknown>[] = [];
let xts: Record<string, { timesheetID: string; employeeID: string; status: string; totalHours: number; lines: any[] }> = {};
let payRuns: Record<string, { PayRunID: string; PayRunStatus: string; NetPay: number }> = {};
let seq = 0, failLines = 0;
const gid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const shift = (id: number, employee: number, date: string, hours: number): Record<string, unknown> => ({
  Id: id, Employee: employee, Date: `${date}T00:00:00+11:00`, TotalTime: hours, TimeApproved: true, Discarded: false, IsInProgress: false,
});

function fake() {
  hits = []; seq = 0; xts = {}; payRuns = {}; failLines = 0;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Deputy: the resource timesheet query returns the approved shifts it was given
      if (p.endsWith("/resource/Timesheet/QUERY")) return json(Number(body?.start ?? 0) === 0 ? shifts : []);
      // Xero Payroll AU v2: timesheets
      if (p.endsWith("/Timesheets") && m === "GET") {
        const status = u.searchParams.get("status");
        const rows = Object.values(xts).filter((t) => !status || t.status === status).map((t) => ({ timesheetID: t.timesheetID, employeeID: t.employeeID, status: t.status, totalHours: t.totalHours }));
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
        return json({ timesheetLine: body });
      }
      const approveTs = p.match(/\/Timesheets\/([^/]+)\/Approve$/);
      if (approveTs && m === "POST") { if (xts[approveTs[1]]) xts[approveTs[1]].status = "Approved"; return json({ timesheet: { timesheetID: approveTs[1], status: "Approved" } }); }
      // Xero Payroll AU v1: pay runs
      if (p.endsWith("/PayRuns") && m === "POST") {
        const id = gid(++seq), row = { PayRunID: id, PayRunStatus: "DRAFT", NetPay: 1234.5 };
        payRuns[id] = row;
        return json({ PayRuns: [row] });
      }
      const pr = p.match(/\/PayRuns\/([^/]+)$/);
      if (pr && m === "GET") return json({ PayRuns: [payRuns[pr[1]]] });
      if (pr && m === "POST") { payRuns[pr[1]].PayRunStatus = body[0].PayRunStatus; return json({ PayRuns: [payRuns[pr[1]]] }); }
      return new Response("not faked: " + m + " " + p, { status: 404 });
    }) as any,
  });
}

/** A live act reaching Xero: approving a timesheet or posting a pay run. Crons must never make one. */
const isLive = (h: Hit) => h.method === "POST" && (/\/Timesheets\/[^/]+\/Approve$/.test(h.path) || /\/PayRuns\/[^/]+$/.test(h.path));
const ctxFor = (store: MemoryStore, settings: any = S, now = NOW) => context(WF, settings, store, now, () => {});
const pendingApprovals = async (store: MemoryStore) => Object.values(await store.list<Approval>("approvals")).filter((a) => a.status === "pending");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, {
    DEPUTY_ACCESS_TOKEN: "d", DEPUTY_SUBDOMAIN: "acme", DEPUTY_REGION: "au",
    XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1",
  });
});

test("record: every operation is in the kit, no op is both draft and live, and each cron is exported", () => {
  const kit = (platform: string) => new Set((JSON.parse(fs.readFileSync(`core/sdk/platforms/${platform}/ops.json`, "utf8")) as { id: string }[]).map((o) => o.id));
  for (const lists of [WF.draft_ops, WF.live_ops] as Record<string, string[]>[]) {
    for (const [platform, ids] of Object.entries(lists)) for (const id of ids) assert.ok(kit(platform).has(id), `${platform} ${id} is in the kit`);
  }
  for (const [platform, ids] of Object.entries(WF.live_ops)) for (const id of ids) assert.ok(!(WF.draft_ops[platform] ?? []).includes(id), `${id} is not also draft`);
  for (const c of WF.crons) assert.ok(typeof (wf.CRONS as Record<string, unknown>)[c.entry] === "function", `${c.entry} is exported`);
  assert.equal(new Set(WF.crons.map((c) => c.name)).size, WF.crons.length);
});

test("mirror: each person gets one draft timesheet, shifts are added once, over-limit shifts are held, nothing is approved", async () => {
  shifts = [shift(1, 101, "2026-11-02", 7.5), shift(2, 101, "2026-11-03", 8), shift(3, 102, "2026-11-02", 6), shift(4, 999, "2026-11-02", 5), shift(5, 103, "2026-11-04", 13)];
  const store = new MemoryStore(), ctx = ctxFor(store);
  assert.deepEqual(await wf.mirror(ctx), { mirrored: 3, flagged: 1, unmapped: 1, failed: 0 });
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/Timesheets")).length, 2, "one timesheet for each of two people");
  assert.equal(hits.filter((h) => /\/Lines$/.test(h.path)).length, 1, "the second shift is one line");
  const sheet = Object.values(xts).find((t) => t.employeeID === EMP_A)!;
  assert.equal(sheet.totalHours, 15.5);
  assert.deepEqual(sheet.lines[0], { date: "2026-11-02", earningsRateID: RATE, numberOfUnits: 7.5 });
  assert.equal(hits.filter(isLive).length, 0, "mirror approves and posts nothing");
  assert.equal((await store.get<{ state: string }>("hours", "deputy:5"))!.state, "flagged");

  assert.deepEqual(await wf.mirror(ctx), { mirrored: 0, flagged: 0, unmapped: 1, failed: 0 }, "a second run adds nothing");
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/Timesheets")).length, 2);
  assert.equal(hits.filter((h) => /\/Lines$/.test(h.path)).length, 1);
});

test("mirror: a write with an unclear outcome is marked needs-check and never retried on its own", async () => {
  shifts = [shift(1, 101, "2026-11-02", 7.5)];
  const store = new MemoryStore(), ctx = ctxFor(store);
  await wf.mirror(ctx);
  shifts = [shift(1, 101, "2026-11-02", 7.5), shift(2, 101, "2026-11-03", 8)];
  failLines = 1;
  assert.deepEqual(await wf.mirror(ctx), { mirrored: 0, flagged: 0, unmapped: 0, failed: 1 });
  assert.equal((await store.get<{ state: string }>("hours", "deputy:2"))!.state, "needs-check");
  assert.deepEqual(await wf.mirror(ctx), { mirrored: 0, flagged: 0, unmapped: 0, failed: 0 });
  assert.equal(hits.filter((h) => /\/Lines$/.test(h.path)).length, 1, "the failed line was not sent again");
});

test("approve: each clean Draft timesheet is queued once, a held person is not, and approval runs only when a person approves", async () => {
  shifts = [shift(1, 101, "2026-11-02", 7.5), shift(2, 102, "2026-11-02", 6), shift(3, 103, "2026-11-04", 4), shift(4, 103, "2026-11-05", 13)];
  const store = new MemoryStore(), ctx = ctxFor(store);
  await wf.mirror(ctx);
  assert.deepEqual(await wf.approve(ctx), { queued: 2, held: 1 });
  assert.deepEqual(await wf.approve(ctxFor(store)), { queued: 2, held: 1 });
  const queued = await pendingApprovals(store);
  assert.equal(queued.length, 2, "re-runs never queue twice");
  assert.equal(hits.filter(isLive).length, 0, "no approval ran on its own");
  const ap = await approve(WF, store, queued[0].id, "owner", NOW);
  assert.equal(ap.status, "done");
  assert.equal(hits.filter((h) => /\/Approve$/.test(h.path) && h.method === "POST").length, 1);
  assert.equal(Object.values(xts).filter((t) => t.status === "Approved").length, 1);
});

test("pay run: waits for approvals, then one DRAFT pay run and one queued posting; posting runs only on approval", async () => {
  shifts = [shift(1, 101, "2026-11-02", 7.5)];
  const store = new MemoryStore();
  await wf.mirror(ctxFor(store));
  assert.deepEqual(await wf.payRun(ctxFor(store)), { waiting: "1 timesheet(s) not yet approved" });
  await wf.approve(ctxFor(store));
  await approve(WF, store, (await pendingApprovals(store))[0].id, "owner", NOW);
  hits = [];   // the timesheet approval above is the person's; the cron below must make no live call of its own

  const first = await wf.payRun(ctxFor(store)) as { queued: string };
  const creates = hits.filter((h) => h.method === "POST" && h.path.endsWith("/PayRuns"));
  assert.equal(creates.length, 1);
  assert.equal(creates[0].body[0].PayRunStatus, "DRAFT", "the pay run is created as a draft");
  assert.equal(creates[0].body[0].PayRunPeriodStartDate, `/Date(${Date.parse("2026-11-02T00:00:00Z")}+0000)/`);
  assert.equal(hits.filter(isLive).length, 0, "nothing posted by the cron");
  const queued = (await pendingApprovals(store)).find((a) => a.id === first.queued)!;
  assert.match(queued.summary, /net pay \$1234\.50/);

  assert.deepEqual(await wf.payRun(ctxFor(store)), { queued: first.queued, already: true });
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/PayRuns")).length, 1, "a second run creates no second pay run");

  const posted = await approve(WF, store, first.queued, "owner", NOW);
  assert.equal(posted.status, "done");
  const post = hits.find((h) => h.method === "POST" && /\/PayRuns\/[^/]+$/.test(h.path))!;
  assert.deepEqual(post.body, [{ PayRunStatus: "POSTED" }]);
});

test("pay run: a held shift stops the pay run, and a bad pay period is refused before any call", async () => {
  shifts = [shift(1, 101, "2026-11-02", 7.5), shift(2, 103, "2026-11-04", 13)];
  const store = new MemoryStore();
  await wf.mirror(ctxFor(store));
  await wf.approve(ctxFor(store));
  assert.deepEqual(await wf.payRun(ctxFor(store)), { waiting: "1 shift(s) held or unconfirmed" });
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/PayRuns")).length, 0);
  hits = [];
  await assert.rejects(wf.payRun(ctxFor(new MemoryStore(), { ...S, pay_period: { start: "2026-11-20", end: "2026-11-02", payment_date: "2026-11-20" } })), /start is after end/);
  assert.equal(hits.length, 0, "no network call for a bad period");
});

test("a cron runs the whole cycle without a single live call", async () => {
  shifts = [shift(1, 101, "2026-11-02", 7.5), shift(2, 102, "2026-11-02", 6)];
  const store = new MemoryStore();
  await wf.mirror(ctxFor(store));
  await wf.approve(ctxFor(store));
  await wf.payRun(ctxFor(store));
  assert.equal(hits.filter(isLive).length, 0);
  assert.equal(hits.filter((h) => h.method === "POST" && h.path.endsWith("/PayRuns")).length, 0, "not drafted until the timesheets are approved");
});
