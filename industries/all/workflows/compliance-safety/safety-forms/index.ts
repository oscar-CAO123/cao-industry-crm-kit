// The safety-forms workflow's three crons. Each is deterministic: it reads SiteBook, generates reports inside it for the
// register, and queues a chase email for approval. Nothing here sends. Judgment (which form a crew needs, what an
// incident means) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings } from "./types.ts";
import { guid, str, DAY } from "./types.ts";
import * as sb from "./adapters/sitebook.ts";

/** Every 30 minutes: generate each open incident's report once, for the register. */
export async function incidents(ctx: Ctx<Settings>) {
  const rows = await sb.openIncidents(ctx);
  let drafted = 0;
  for (const r of rows) {
    const id = guid(r.IncidentId);
    if (!id || (await ctx.store.get("incidents", id))) continue;
    await sb.draftIncidentReport(ctx, id);
    await ctx.store.put("incidents", id, { reported: ctx.now.toISOString(), number: str(r.IncidentNumber, 40), type: str(r.IncidentType, 60) });
    drafted++;
  }
  ctx.log(`incidents: ${rows.length} open, ${drafted} reports generated`);
  return { open: rows.length, drafted };
}

/** Hourly: generate each completed checklist's report once, for the register. */
export async function checklists(ctx: Ctx<Settings>) {
  const rows = await sb.completedChecklists(ctx);
  let drafted = 0;
  for (const r of rows) {
    const id = guid(r.CheckListId);
    if (!id || (await ctx.store.get("checklists", id))) continue;
    await sb.draftChecklistReport(ctx, id);
    await ctx.store.put("checklists", id, { reported: ctx.now.toISOString(), completed: str(r.CompletedOn, 40), title: str(r.Title, 120) });
    drafted++;
  }
  ctx.log(`checklists: ${rows.length} completed, ${drafted} reports generated`);
  return { completed: rows.length, drafted };
}

/** Each morning: queue one chase email per overdue action per week. A repeat run in the same week queues nothing new. */
export async function actions(ctx: Ctx<Settings>) {
  const rows = await sb.overdueActions(ctx);
  const week = weekKey(ctx.now);
  let queued = 0;
  for (const r of rows) {
    const id = guid(r.ActionId);
    if (!id) continue;
    await sb.queueChase(ctx, id, `chase-${id}-${week}`, r.DueDate);
    queued++;
  }
  ctx.log(`actions: ${rows.length} overdue, ${queued} chase emails queued for approval`);
  return { overdue: rows.length, queued };
}

/** The year and week of a date, so a chase is queued at most once a week. */
function weekKey(d: Date): string {
  const y = d.getUTCFullYear();
  const week = Math.floor((d.getTime() - Date.UTC(y, 0, 1)) / (7 * DAY));
  return `${y}w${String(week).padStart(2, "0")}`;
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { incidents, checklists, actions };
