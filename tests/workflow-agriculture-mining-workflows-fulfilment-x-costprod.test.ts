// Cost of production workflow tests. Every request goes to a fake network: no test reaches a real Xero account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { actuals, budgetCompare, CRONS } from "../industries/agriculture-mining/workflows/fulfilment/x-costprod/index.ts";
import fs from "node:fs";

const DIR = "industries/agriculture-mining/workflows/fulfilment/x-costprod";
const WF = JSON.parse(fs.readFileSync(`${DIR}/workflow.json`, "utf8")) as WorkflowRecord;
const BID = "11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-11-08T00:00:00Z");
const SETTINGS: any = { books: "xero", season_start: "2026-07-01", cost_types: ["DIRECTCOSTS", "EXPENSE", "OVERHEADS"], budget_id: BID, volume: { unit: "hectare", quantity: 200 } };

type Hit = { method: string; path: string };
let hits: Hit[] = [];

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      hits.push({ method: m, path: p });
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (/token$/.test(p)) return json({ access_token: "tok", refresh_token: "r2", expires_in: 1800 });
      if (p.endsWith("/connections")) return json([{ tenantId: "t" }]);
      if (p.endsWith("/Accounts")) return json({ Accounts: [
        { Code: "300", Name: "Fertiliser", Type: "DIRECTCOSTS", Status: "ACTIVE" },
        { Code: "310", Name: "Fuel", Type: "DIRECTCOSTS", Status: "ACTIVE" },
        { Code: "320", Name: "Old chemical", Type: "DIRECTCOSTS", Status: "ARCHIVED" },
        { Code: "400", Name: "Sales", Type: "REVENUE", Status: "ACTIVE" } ] });
      if (p.endsWith("/Reports/ProfitAndLoss")) return json({ Reports: [{ ReportID: "ProfitAndLoss", Rows: [
        { RowType: "Header", Cells: [{ Value: "" }, { Value: "Jul 2026 to Nov 2026" }] },
        { RowType: "Section", Title: "Less Cost of Sales", Rows: [
          { RowType: "Row", Cells: [{ Value: "Fertiliser" }, { Value: "1,200.50" }] },
          { RowType: "Row", Cells: [{ Value: "Fuel" }, { Value: "800" }] },
          { RowType: "Row", Cells: [{ Value: "Old chemical" }, { Value: "50" }] },
          { RowType: "Row", Cells: [{ Value: "Sales" }, { Value: "9999" }] } ] } ] }] });
      if (p.endsWith(`/Budgets/${BID}`)) return json({ Budgets: [{ BudgetID: BID, BudgetLines: [
        { AccountCode: "300", BudgetBalances: [{ Period: "2026-07-01", Amount: 1000 }] },
        { AccountCode: "310", BudgetBalances: [{ Period: "2026-07-01", Amount: 500 }, { Period: "2026-08-01", Amount: 500 }] } ] }] });
      return new Response("not faked: " + p, { status: 404 });
    }) as any,
  });
}

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { XERO_CLIENT_ID: "x", XERO_CLIENT_SECRET: "y", XERO_TENANT_ID: "t", XERO_REFRESH_TOKEN: "r1" });
});

test("the workflow record matches its crons and allows reads only", () => {
  assert.deepEqual(WF.crons.map((c) => c.entry).sort(), Object.keys(CRONS).sort());
  assert.deepEqual(WF.live_ops, {});
  for (const op of WF.draft_ops.xero) assert.match(op, /^accounting\.get/);
});

test("runtime: a cron cannot run a write, and nothing can be queued", async () => {
  const ctx = context(WF, SETTINGS, new MemoryStore(), NOW, () => {});
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.draft({ platform: "xero", op: "accounting.updateQuote", summary: "x" }), /not a draft operation/);
  await assert.rejects(ctx.queue({ platform: "xero", op: "accounting.createInvoices", summary: "x" }), /not a live operation/);
});

test("actuals drafts cost lines and cost per unit, reads only, and ignores revenue and archived accounts", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  const out: any = await actuals(ctx);
  assert.equal(out.lines, 2);
  assert.equal(out.total, 2000.5);
  assert.equal(out.cost_per_unit, 10.00);
  const saved: any = await store.get("cost-summaries", "season-2026-07-01");
  assert.deepEqual(saved.lines.map((l: any) => l.name), ["Fertiliser", "Fuel"]);
  const data = hits.filter((h) => !/token$/.test(h.path));
  assert.ok(data.length > 0 && data.every((h) => h.method === "GET"), "every Xero data call is a read");
});

test("budget-compare drafts actual against budget per account", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await budgetCompare(ctx);
  const saved: any = await store.get("budget-variance", "season-2026-07-01");
  const row = (n: string) => saved.rows.find((r: any) => r.name === n);
  assert.deepEqual({ a: row("Fertiliser").actual, b: row("Fertiliser").budget, v: row("Fertiliser").variance }, { a: 1200.5, b: 1000, v: 200.5 });
  assert.deepEqual({ a: row("Fuel").actual, b: row("Fuel").budget, v: row("Fuel").variance }, { a: 800, b: 1000, v: -200 });
  assert.equal(row("Sales"), undefined);
});

test("a bad budget id is refused before any network call", async () => {
  const ctx = context(WF, { ...SETTINGS, budget_id: "not-a-guid" }, new MemoryStore(), NOW, () => {});
  await assert.rejects(budgetCompare(ctx), /bad budget id/);
  assert.ok(!hits.some((h) => h.path.includes("/Budgets/")), "no budget call was made");
});

test("re-running a cron overwrites its own summary and never duplicates it", async () => {
  const store = new MemoryStore();
  const ctx = context(WF, SETTINGS, store, NOW, () => {});
  await actuals(ctx); await actuals(ctx);
  const all = await store.list("cost-summaries");
  assert.equal(Object.keys(all).length, 1);
});

test("with no budget id, budget-compare does nothing", async () => {
  const ctx = context(WF, { ...SETTINGS, budget_id: "" }, new MemoryStore(), NOW, () => {});
  assert.deepEqual(await budgetCompare(ctx), { compared: 0 });
  assert.equal(hits.length, 0);
});
