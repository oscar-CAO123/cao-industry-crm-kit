// The costs workflow's three crons. Each reads and drafts (records in the store) or queues for approval.
// None of them sends, pays or changes a live record. Judgment (what an overrun means for a job) belongs to the agent in SKILL.md.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId, reject, safeKey } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type BudgetRow, type SpendRow, type Timesheet, type Holds, HOLDS_NS, checkSettings, round } from "./types.ts";
import { readBudgets, readSpend, draftTimesheets, approveTimesheetAct, timesheetKey } from "./adapters/xero.ts";

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

/** A person is held for a timesheet when x-labour holds them for a pay period that overlaps the timesheet's dates.
 *  A timesheet with no dates is treated as overlapping, so a hold is never missed for want of a date. */
const heldFor = (t: Timesheet, holds: Holds[]) => holds.some((h) =>
  h.employees.includes(t.employeeID ?? "") && (!t.startDate || !t.endDate || (t.startDate <= h.end && t.endDate >= h.start)));

/** Every hour at quarter past: queue each draft timesheet for a person to approve, except a person the labour workflow holds.
 *  An approval already queued for a person who becomes held is withdrawn here. Nothing is approved here. */
export async function timesheetApproval(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const sheets = await draftTimesheets(ctx);
  const holds = Object.values(await ctx.store.list<Holds>(HOLDS_NS));
  let queued = 0, held = 0, withdrawn = 0;
  for (const t of sheets) {
    if (heldFor(t, holds)) {
      held++;
      const id = approvalId(ctx.workflow.id, timesheetKey(t.timesheetID));
      const ap = await ctx.store.get<Approval>("approvals", id);
      if (ap?.status === "pending") { await reject(ctx.workflow, ctx.store, id, "timesheet-holds", ctx.now); withdrawn++; }
      continue;
    }
    await ctx.queue(approveTimesheetAct(t));
    queued++;
  }
  ctx.log(`timesheet-approval: ${queued} draft timesheets queued, ${held} held, ${withdrawn} queued approval(s) withdrawn`);
  return { waiting: queued, held, withdrawn };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "budget-watch": budgetWatch,
  "spend-watch": spendWatch,
  "timesheet-approval": timesheetApproval,
};
