// The health-care budget workflow's two crons. Each one reads Xero and writes its own store record. Nothing is sent or changed.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { BurnRead, Settings } from "./types.ts";
import { day } from "./types.ts";
import { readBudgets, readBurnReport } from "./adapters/xero.ts";

/** Daily: copy the budgets (planned amounts per account and period) into the store, so the burn read has a plan to check against. */
export async function budgetRead(ctx: Ctx<Settings>) {
  const budgets = await readBudgets(ctx);
  for (const b of budgets) await ctx.store.put("budgets", b.id, b);
  ctx.log(`budget-read: ${budgets.length} budgets`);
  return { budgets: budgets.length };
}

/** Daily: store the budget summary report under today's date for the agent's burn read. */
export async function burnCheck(ctx: Ctx<Settings>) {
  const report = await readBurnReport(ctx);
  const key = day(ctx.now);
  await ctx.store.put("burn", key, { date: key, timeframe: ctx.settings.timeframe ?? "MONTH", report } satisfies BurnRead);
  ctx.log(`burn-check: stored ${key}`);
  return { date: key };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "budget-read": budgetRead, "burn-check": burnCheck };
