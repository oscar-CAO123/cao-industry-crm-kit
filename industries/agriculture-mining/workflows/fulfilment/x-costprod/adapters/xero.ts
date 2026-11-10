// Xero: the ledger. This workflow only reads: chart of accounts, profit and loss, and one budget.
// Field names come from the Xero accounting spec (Account, ReportWithRows, ReportRows, Budget, BudgetLine, BudgetBalance).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Account, type CostLine, type Settings, GUID } from "../types.ts";

const P = "xero";
const MAX_DEPTH = 8;

/** Active accounts of the cost types in settings. */
export async function costAccounts(ctx: Ctx<Settings>): Promise<Account[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getAccounts", summary: "read chart of accounts" });
  const types = new Set(ctx.settings.cost_types);
  return (r.data?.Accounts ?? [])
    .filter((a: any) => a.Status === "ACTIVE" && types.has(String(a.Type)) && a.Name)
    .map((a: any): Account => ({ code: String(a.Code ?? ""), name: String(a.Name) }));
}

/** Cost lines from the profit and loss report: a row counts only when its label is a cost account name. */
export async function actualsFor(ctx: Ctx<Settings>, accounts: Account[], from: string, to: string): Promise<CostLine[]> {
  const names = new Set(accounts.map((a) => a.name));
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getReportProfitAndLoss", summary: `profit and loss ${from} to ${to}`,
    input: { params: { fromDate: from, toDate: to } } });
  const lines: CostLine[] = [];
  const walk = (rows: any[], depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const row of rows) {
      if (row?.RowType === "Row" && Array.isArray(row.Cells)) {
        const label = String(row.Cells[0]?.Value ?? "");
        const raw = String(row.Cells[1]?.Value ?? "").replace(/,/g, "");
        if (names.has(label) && raw !== "" && Number.isFinite(Number(raw))) lines.push({ name: label, amount: Number(raw) });
      }
      if (Array.isArray(row?.Rows)) walk(row.Rows, depth + 1);
    }
  };
  walk(r.data?.Reports?.[0]?.Rows ?? [], 0);
  return lines;
}

/** Budget balances summed per account name. The budget id is checked before any call is made. */
export async function budgetFor(ctx: Ctx<Settings>, accounts: Account[], budgetId: string): Promise<Map<string, number>> {
  if (!GUID.test(budgetId)) throw new Error("xero: bad budget id");
  const byCode = new Map(accounts.map((a) => [a.code, a.name]));
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getBudget", summary: "read budget", input: { params: { BudgetID: budgetId } } });
  const out = new Map<string, number>();
  for (const line of r.data?.Budgets?.[0]?.BudgetLines ?? []) {
    const name = byCode.get(String(line.AccountCode ?? ""));
    if (!name) continue;
    for (const b of line.BudgetBalances ?? []) {
      const amt = Number(b.Amount);
      if (Number.isFinite(amt)) out.set(name, (out.get(name) ?? 0) + amt);
    }
  }
  return out;
}
