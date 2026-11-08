// The agency ops board's three crons. Each reads, drafts internal records or queues a live step for approval; none sends.
// Judgment (scoping a brief, writing a client status update) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Brief, type Settings, type Warned, day, settingsOk } from "./types.ts";
import { newBriefs, opsTask, budgets, invoicesDue, markSentAct } from "./adapters/productive.ts";

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 160);

/** Every 30 minutes: a scoping task on the ops board for each new brief. Each deal gets one task, ever. */
export async function intake(ctx: Ctx<Settings>) {
  settingsOk(ctx.settings);
  let added = 0, failed = 0;
  for (const b of await newBriefs(ctx)) {
    if (await ctx.store.get("briefs", b.id)) continue;
    try {
      const task = await opsTask(ctx, `Scope brief: ${b.title}`, `Productive deal ${b.id}. Estimate hours and fee before it is agreed.`);
      await ctx.store.put("briefs", b.id, { ...b, status: "task-drafted", task_id: task } satisfies Brief);
      added++;
    } catch (e) {
      failed++;
      ctx.log(`intake: deal ${b.id} not drafted: ${errText(e)}`);
    }
  }
  ctx.log(`intake: ${added} briefs drafted, ${failed} failed`);
  return { added, failed };
}

/** Hourly: budget use per project. A project past the warning level gets one budget task per calendar month. */
export async function board(ctx: Ctx<Settings>) {
  const s = settingsOk(ctx.settings);
  const warn = s.budget_warning_percent ?? 80;
  const month = day(ctx.now).slice(0, 7);
  let flagged = 0, failed = 0;
  for (const b of await budgets(ctx)) {
    await ctx.store.put("budget", b.project_id, { ...b, checked: ctx.now.toISOString() });
    if (b.budget_usage < warn) continue;
    const key = `${b.project_id}-${month}`;
    if (await ctx.store.get("warned", key)) continue;
    try {
      const task = await opsTask(ctx, `Budget at ${Math.round(b.budget_usage)} percent: project ${b.project_id}`,
        `Budget use passed ${warn} percent this month. Check scope and hours before more work.`);
      await ctx.store.put("warned", key, { project_id: b.project_id, month, task_id: task } satisfies Warned);
      flagged++;
    } catch (e) {
      failed++;
      ctx.log(`board: project ${b.project_id} not flagged: ${errText(e)}`);
    }
  }
  ctx.log(`board: ${flagged} flagged, ${failed} failed`);
  return { flagged, failed };
}

/** Daily: queue each invoice whose delivery date has passed for approval to be marked sent. Nothing is marked sent here. */
export async function invoicing(ctx: Ctx<Settings>) {
  settingsOk(ctx.settings);
  const today = day(ctx.now);
  let queued = 0;
  for (const inv of await invoicesDue(ctx, today)) {
    await ctx.queue(markSentAct(inv, today), `mark invoice ${inv.number || inv.id} sent (delivery date ${inv.delivery_on})`);
    queued++;
  }
  ctx.log(`invoicing: ${queued} queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, board, invoicing };
