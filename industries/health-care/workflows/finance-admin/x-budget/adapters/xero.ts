// Xero: the budgets and the budget summary report the burn read is built from. Read only. This workflow maps no
// Xero write operation for budgets, so nothing here changes the books.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Budget, BudgetLine, Settings } from "../types.ts";
import { day } from "../types.ts";

const P = "xero";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };

/** Every budget in the connected Xero organisation, with its planned amount per account and period. */
export async function readBudgets(ctx: Ctx<Settings>): Promise<Budget[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getBudgets", summary: "read budgets" });
  return (r.data?.Budgets ?? []).map((b: any): Budget => ({
    id: guid(b.BudgetID),
    type: String(b.Type ?? "").slice(0, 20),
    description: String(b.Description ?? "").slice(0, 255),
    lines: (b.BudgetLines ?? []).map((l: any): BudgetLine => ({
      account_code: String(l.AccountCode ?? "").slice(0, 50),
      account_id: l.AccountID ? guid(l.AccountID) : undefined,
      balances: (l.BudgetBalances ?? [])
        .map((x: any) => ({ period: String(x.Period ?? "").slice(0, 40), amount: Number(x.Amount) }))
        .filter((x: { amount: number }) => Number.isFinite(x.amount)),
    })),
  }));
}

/** The budget summary report for the window ending today, as Xero returns it. */
export async function readBurnReport(ctx: Ctx<Settings>): Promise<unknown> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getReportBudgetSummary", summary: "budget summary report",
    input: { params: { date: day(ctx.now), timeframe: ctx.settings.timeframe ?? "MONTH" } } });
  return r.data?.Reports ?? [];
}
