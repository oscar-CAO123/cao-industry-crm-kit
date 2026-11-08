// The costs workflow's three crons. Each reads and drafts (records in the store) or queues for approval.
// None of them sends, pays or changes a live record. Judgment (what an overrun means for a job) belongs to the agent in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type BudgetRow, type SpendRow, checkSettings, round } from "./types.ts";
import { readBudgets, readSpend, draftTimesheets, approveTimesheetAct } from "./adapters/xero.ts";

/** Daily: read each budget line for the period and keep it as the baseline the spend check compares against. */
export async function budgetWatch(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const rows = await readBudgets(ctx);
  for (const r of rows) await ctx.store.put("budgets", r.key, r);
  ctx.log(`budget-watch: ${rows.length} budget lines`);
  return { budget_lines: rows.length };
}

/** Every two hours: compare committed plus actual cost with the budget for each account code; record every line over budget. */
export async function spendWatch(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const budgets = Object.values(await ctx.store.list<BudgetRow>("budgets"));
  if (!budgets.length) { ctx.log("spend-watch: no budgets yet, budget-watch runs first"); return { checked: 0, flagged: 0 }; }
  const byCode = new Map<string, number>();
  for (const b of budgets) byCode.set(b.account_code, round((byCode.get(b.account_code) ?? 0) + b.budget));
  const spend = await readSpend(ctx);
  const tol = (ctx.settings.overrun_tolerance_percent ?? 0) / 100;
  let flagged = 0;
  for (const [code, budget] of byCode) {
    const s = spend.get(code) ?? { committed: 0, actual: 0 };
    const exposure = round(s.committed + s.actual);
    const over = round(exposure - budget * (1 + tol));
    const row: SpendRow = { key: safeKey(`spend:${code}`), account_code: code, budget, committed: s.committed, actual: s.actual,
                            exposure, over_by: Math.max(0, over), flagged: over > 0, checked: ctx.now.toISOString() };
    await ctx.store.put("spend", row.key, row);
    if (row.flagged) flagged++;
  }
  ctx.log(`spend-watch: ${byCode.size} account codes checked, ${flagged} over budget`);
  return { checked: byCode.size, flagged };
}

/** Every hour at quarter past: queue each draft timesheet for a person to approve. Nothing is approved here. */
export async function timesheetApproval(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const sheets = await draftTimesheets(ctx);
  for (const t of sheets) await ctx.queue(approveTimesheetAct(t));
  ctx.log(`timesheet-approval: ${sheets.length} draft timesheets waiting`);
  return { waiting: sheets.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "budget-watch": budgetWatch,
  "spend-watch": spendWatch,
  "timesheet-approval": timesheetApproval,
};
