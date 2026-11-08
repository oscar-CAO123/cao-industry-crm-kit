// Health-care budget workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { CRONS } from "../industries/health-care/workflows/finance-admin/x-budget/index.ts";

const DIR = "industries/health-care/workflows/finance-admin/x-budget";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const SETTINGS: any = { business_name: "Test Clinic", timeframe: "MONTH" };
const NOW = new Date("2026-11-08T00:00:00Z");
const BUDGET = "11111111-2222-4333-8444-555555555555", ACCT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
type Hit = { method: string; path: string; query: string };
let hits: Hit[] = [];
let badBudget = false;

function fake() {
  hits = []; badBudget = false;
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      hits.push({ method: m, path: p, query: u.search });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Budgets")) return json({ Budgets: [{ BudgetID: badBudget ? "not-a-guid" : BUDGET, Type: "OVERALL", Description: "FY27 clinic",
        BudgetLines: [{ AccountID: ACCT, AccountCode: "400", BudgetBalances: [{ Period: "2026-11", Amount: 12000 }] }] }] });
      if (p.endsWith("/Reports/BudgetSummary")) return json({ Reports: [{ ReportName: "BudgetSummary", ReportTitle: "Budget Summary" }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1", KIT_ALLOW_WRITES: "1" });
});

test("crons only read: every request is a GET and nothing is queued, even on a re-run", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await CRONS["budget-read"](ctx); await CRONS["burn-check"](ctx);
  await CRONS["budget-read"](ctx); await CRONS["burn-check"](ctx);
  const api = hits.filter((h) => h.path.includes("/api.xro/"));
  assert.ok(api.length >= 4);
  assert.ok(api.every((h) => h.method === "GET"), "every Xero API request is a read");
  assert.deepEqual(Object.keys(await store.list("approvals")), []);
});

test("budgets and the burn read are stored under their keys", async () => {
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  assert.deepEqual(await CRONS["budget-read"](ctx), { budgets: 1 });
  const budget = await store.get<any>("budgets", BUDGET);
  assert.equal(budget.lines[0].balances[0].amount, 12000);
  assert.deepEqual(await CRONS["burn-check"](ctx), { date: "2026-11-08" });
  const burn = await store.get<any>("burn", "2026-11-08");
  assert.equal(burn.timeframe, "MONTH");
  assert.ok(hits.some((h) => h.path.endsWith("/Reports/BudgetSummary") && h.query.includes("timeframe=MONTH")));
});

test("a malformed budget id stops the read and stores nothing", async () => {
  badBudget = true;
  const store = new MemoryStore(), ctx = context(WF, SETTINGS, store, NOW, () => {});
  await assert.rejects(CRONS["budget-read"](ctx), /bad id/);
  assert.deepEqual(Object.keys(await store.list("budgets")), []);
});

test("a write operation is refused as a draft and cannot be queued", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateInvoice", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.updateInvoice", summary: "x" }), /not a live operation/);
});
