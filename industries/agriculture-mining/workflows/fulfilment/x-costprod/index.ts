// The cost of production workflow's two crons. Each only reads the ledger and drafts a summary into the
// workflow's own store. Nothing is queued, sent or booked. Judgment (what counts as a cost, scenarios, allocations)
// stays with the person; see SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, CostLine, CostSummary, Variance } from "./types.ts";
import { day, round2 } from "./types.ts";
import { costAccounts, actualsFor, budgetFor } from "./adapters/xero.ts";

const seasonKey = (s: Settings) => `season-${s.season_start}`;

function summarise(s: Settings, lines: CostLine[], asAt: string): CostSummary {
  const total = round2(lines.reduce((a, l) => a + l.amount, 0));
  const out: CostSummary = { season_start: s.season_start, as_at: asAt, lines, total };
  const qty = s.volume?.quantity;
  if (s.volume?.unit && typeof qty === "number" && Number.isFinite(qty) && qty > 0) {
    out.unit = s.volume.unit; out.quantity = qty; out.cost_per_unit = round2(total / qty);
  }
  return out;
}

/** Daily: read this season's cost lines from the ledger and draft the cost summary, with cost per unit when a volume is set. */
export async function actuals(ctx: Ctx<Settings>) {
  const to = day(ctx.now);
  const accounts = await costAccounts(ctx);
  const lines = await actualsFor(ctx, accounts, ctx.settings.season_start, to);
  const summary = summarise(ctx.settings, lines, to);
  await ctx.store.put("cost-summaries", seasonKey(ctx.settings), summary);
  ctx.log(`actuals: ${lines.length} cost lines, total ${summary.total}`);
  return { lines: lines.length, total: summary.total, cost_per_unit: summary.cost_per_unit ?? null };
}

/** Weekly: actual against budget for each cost account. The budget is the full season total, not pro-rated yet. */
export async function budgetCompare(ctx: Ctx<Settings>) {
  const budgetId = ctx.settings.budget_id;
  if (!budgetId) { ctx.log("budget-compare: no budget_id in settings, nothing to compare"); return { compared: 0 }; }
  const to = day(ctx.now);
  const accounts = await costAccounts(ctx);
  const [lines, budget] = await Promise.all([actualsFor(ctx, accounts, ctx.settings.season_start, to), budgetFor(ctx, accounts, budgetId)]);
  const actual = new Map(lines.map((l) => [l.name, l.amount]));
  const names = new Set([...actual.keys(), ...budget.keys()]);
  const rows: Variance[] = [...names].sort().map((name) => {
    const a = round2(actual.get(name) ?? 0), b = round2(budget.get(name) ?? 0);
    return { name, actual: a, budget: b, variance: round2(a - b) };
  });
  await ctx.store.put("budget-variance", seasonKey(ctx.settings), { season_start: ctx.settings.season_start, as_at: to, rows });
  ctx.log(`budget-compare: ${rows.length} cost accounts`);
  return { compared: rows.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { actuals, "budget-compare": budgetCompare };
