// Costs workflow tests. Every request goes to a fake network: no test reaches a real Xero account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { budgetWatch, spendWatch, timesheetApproval } from "../industries/construction/workflows/fulfilment/costs/index.ts";
import fs from "node:fs";
import { HOLDS_NS } from "../industries/construction/workflows/fulfilment/costs/types.ts";
import { HOLDS_NS as LABOUR_HOLDS_NS } from "../industries/construction/workflows/finance-admin/x-labour/types.ts";

const WF = JSON.parse(fs.readFileSync("industries/construction/workflows/fulfilment/costs/workflow.json", "utf8")) as WorkflowRecord;
const B1 = "11111111-2222-4333-8444-555555555555", T1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", E1 = "99999999-8888-4777-8666-555555555555";
const NOW = new Date("2026-11-09T00:00:00Z");
const S: any = { family: "job-cost-tracking", budget_from: "2026-07-01", budget_to: "2027-06-30", overrun_tolerance_percent: 0, business_name: "Test Civil" };

type Hit = { method: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];
let approved = 0, poPages = 1, budgetCount = 1;

function fake() {
  hits = []; approved = 0; poPages = 1; budgetCount = 1;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, path: p, query: u.searchParams, body });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      // Budgets: account 500 budget 1000, account 510 budget 400
      if (p.endsWith("/Budgets") && m === "GET") return json({ Budgets: Array.from({ length: budgetCount }, (_, i) => ({ BudgetID: i === 0 ? B1 : `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, Description: "FY27 cost budget" })) });
      if (p.endsWith(`/Budgets/${B1}`)) return json({ Budgets: [{ BudgetID: B1, Description: "FY27 cost budget", BudgetLines: [
        { AccountCode: "500", BudgetBalances: [{ Period: "2026-11", UnitAmount: 1000, Amount: 1 }] },
        { AccountCode: "510", BudgetBalances: [{ Period: "2026-11", UnitAmount: 400, Amount: 1 }] }] }] });
      // Purchase orders: 700 authorised and 300 billed on 500, 50 submitted on 510
      if (p.endsWith("/PurchaseOrders")) { const pg = Number(u.searchParams.get("page")); return json({ PurchaseOrders: pg === 1 ? [
        { Status: "AUTHORISED", LineItems: [{ AccountCode: "500", LineAmount: 700 }] },
        { Status: "BILLED", LineItems: [{ AccountCode: "500", LineAmount: 300 }] },
        { Status: "SUBMITTED", LineItems: [{ AccountCode: "510", LineAmount: 50 }] }] : pg <= poPages ? [{ Status: "SUBMITTED", LineItems: [{ AccountCode: "510", LineAmount: 1 }] }] : [] }); }
      // Bills: 450 authorised on 500, a 9999 draft on 500 that must not count
      if (p.endsWith("/Invoices")) return json({ Invoices: u.searchParams.get("page") === "1" ? [
        { Type: "ACCPAY", Status: "AUTHORISED", LineItems: [{ AccountCode: "500", LineAmount: 450 }] },
        { Type: "ACCPAY", Status: "DRAFT", LineItems: [{ AccountCode: "500", LineAmount: 9999 }] }] : [] });
      // Payroll timesheets: one in Draft
      if (p.endsWith("/Timesheets") && m === "GET") return json({ timesheets: [{ timesheetID: T1, employeeID: E1, startDate: "2026-11-02", endDate: "2026-11-08", status: "Draft", totalHours: 38 }] });
      if (p.endsWith(`/Timesheets/${T1}/Approve`)) { approved++; return json({ timesheets: [{ timesheetID: T1, status: "Approved" }] }); }
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("budget-watch and spend-watch only read: no write reaches Xero", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await budgetWatch(ctx);
  await spendWatch(ctx);
  assert.ok(hits.length > 0);
  const business = hits.filter((h) => !/token$|connections$/.test(h.path));   // the auth refresh is a POST, not a Xero write
  assert.ok(business.length > 0);
  assert.ok(business.every((h) => h.method === "GET"), "no POST or PUT to Xero from a cron");
});

test("spend-watch counts open orders and authorised bills, flags only the line over budget", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await budgetWatch(ctx);
  const r: any = await spendWatch(ctx);
  assert.deepEqual(r, { checked: 2, flagged: 1 });
  const s500 = await store.get<any>("spend", "spend:500");
  assert.equal(s500.budget, 1000);
  assert.equal(s500.committed, 700, "billed order not counted twice");
  assert.equal(s500.actual, 450, "draft bill not counted");
  assert.equal(s500.exposure, 1150);
  assert.equal(s500.over_by, 150);
  assert.equal(s500.flagged, true);
  const s510 = await store.get<any>("spend", "spend:510");
  assert.equal(s510.flagged, false);
});

test("the Xero date filter is built from checked digits only", async () => {
  const store = new MemoryStore();
  await assert.rejects(spendWatch(context(WF, { ...S, budget_from: "2026-07-01'); DROP" }, store, NOW, () => {})), /budget_from/);
  await assert.rejects(spendWatch(context(WF, { ...S, budget_from: "2026-02-31" }, store, NOW, () => {})), /real YYYY-MM-DD/);
});

test("timesheet-approval queues one approval and never approves on its own", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await timesheetApproval(ctx);
  await timesheetApproval(ctx);
  const all = Object.values(await store.list<Approval>("approvals"));
  assert.equal(all.length, 1, "a second run never queues the same timesheet again");
  assert.equal(all[0].status, "pending");
  assert.equal(approved, 0, "nothing approved by the cron");
});

test("an approved timesheet runs the approval once, with the write gate open", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await timesheetApproval(ctx);
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  const done = await approve(WF, store, ap.id, "owner", NOW);
  assert.equal(done.status, "done");
  assert.equal(approved, 1);
});

test("a draft call cannot run the approval operation", async () => {
  const ctx = context(WF, S, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "payroll-au-v2.approveTimesheet", summary: "x" }), /not a draft operation/);
  assert.equal(approved, 0);
});

test("spend-watch: a purchase order list past the page cap is an error, never a partial total", async () => {
  poPages = 25;
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await budgetWatch(ctx);
  await assert.rejects(spendWatch(ctx), /more than 20 pages/);
  assert.equal(await store.get("spend", "spend:500"), undefined, "nothing recorded from a partial read");
});

test("budget-watch: more budgets than the baseline holds is an error, never a silent cut", async () => {
  budgetCount = 51;
  await assert.rejects(budgetWatch(context(WF, S, new MemoryStore(), NOW, () => {})), /51 budgets in Xero, more than 50/);
});

const holdFor = (start: string, end: string) => ({ employees: [E1], at: "2026-11-08T00:00:00.000Z", start, end });

test("the hold record is the one the labour workflow writes", () => {
  assert.equal(HOLDS_NS, LABOUR_HOLDS_NS);
});

test("a person the labour workflow holds for an overlapping pay period is not queued here", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put(HOLDS_NS, "period:2026-11-02", holdFor("2026-11-02", "2026-11-15"));
  assert.deepEqual(await timesheetApproval(ctx), { waiting: 0, held: 1, withdrawn: 0 });
  assert.equal(Object.values(await store.list<Approval>("approvals")).length, 0, "nothing queued for the held person");
  assert.equal(approved, 0);
});

test("a hold for a pay period that does not overlap the timesheet does not hold it", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  await store.put(HOLDS_NS, "period:2026-10-19", holdFor("2026-10-19", "2026-11-01"));
  assert.deepEqual(await timesheetApproval(ctx), { waiting: 1, held: 0, withdrawn: 0 });
});

test("a queued approval is withdrawn once the labour workflow holds its person, and stays withdrawn", async () => {
  const store = new MemoryStore(), ctx = context(WF, S, store, NOW, () => {});
  assert.deepEqual(await timesheetApproval(ctx), { waiting: 1, held: 0, withdrawn: 0 });
  await store.put(HOLDS_NS, "period:2026-11-02", holdFor("2026-11-02", "2026-11-15"));
  assert.deepEqual(await timesheetApproval(ctx), { waiting: 0, held: 1, withdrawn: 1 });
  const [ap] = Object.values(await store.list<Approval>("approvals"));
  assert.equal(ap.status, "rejected");
  await assert.rejects(approve(WF, store, ap.id, "owner", NOW), /already rejected/);
  assert.equal(approved, 0, "nothing approved");
});
