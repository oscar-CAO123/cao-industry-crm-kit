// The job budgets crons. Each one reads and drafts internal records only. Nothing here sends, pays or changes a
// status a client sees. Judgment (how a budget was set, what a change is worth) belongs to SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings } from "./types.ts";
import { xero } from "./adapters/xero.ts";

/** Every 6 hours: read each job's estimate against its spend and keep the snapshot. */
export async function burn(ctx: Ctx<Settings>) {
  const jobs = await xero.projects(ctx);
  const at = ctx.now.toISOString();
  for (const j of jobs) await ctx.store.put("burn", j.id, { ...j, at });
  ctx.log(`burn: ${jobs.length} jobs`);
  return { jobs: jobs.length };
}

/** Every morning: flag each job that has spent its warning share of the estimate, or is over it. */
export async function overrun(ctx: Ctx<Settings>) {
  const pct = ctx.settings.overrun_pct ?? 90;
  const jobs = await xero.projects(ctx);
  let flagged = 0;
  for (const j of jobs) {
    if (j.estimate === null || j.estimate <= 0) continue;
    const share = (j.spent / j.estimate) * 100;
    if (share < pct) continue;
    flagged++;
    await ctx.store.put("overruns", j.id, { id: j.id, name: j.name, estimate: j.estimate, spent: j.spent, share: Math.round(share), over: j.spent > j.estimate, at: ctx.now.toISOString() });
  }
  ctx.log(`overrun: ${flagged} flagged`);
  return { flagged };
}

export const CRONS = { burn, overrun };
