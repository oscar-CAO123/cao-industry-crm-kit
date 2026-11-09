// The safety paperwork workflow's three crons. Each reads SiteBook and drafts internal records; the only outbound
// action (a reminder email) is queued for approval. Judgment (writing a SWMS for a new task, close-out photos,
// the handover pack) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings } from "./types.ts";
import { DAY, guidOrNull } from "./types.ts";
import { jobs, createPrestart, attachSwms, swmsList, raiseReview, openActions, queueReminder } from "./adapters/sitebook.ts";

type PreStart = { checkListId?: string; pending?: boolean; swmsAttached: boolean; created: string };

/** Weekday mornings: a pre-start checklist for each job that has none, with the standard SWMS attached. */
export async function prestart(ctx: Ctx<Settings>) {
  const s = ctx.settings.prestart;
  if (!s?.template_checklist_id) { ctx.log("prestart: no template set"); return { created: 0, attached: 0 }; }
  if (!s.asset_id && !s.asset_group_id) { ctx.log("prestart: no asset_id or asset_group_id set (SiteBook needs one on checklist create)"); return { created: 0, attached: 0 }; }
  // Refuse a bad setting here, before any job is marked pending for a call that could never be made.
  if (!guidOrNull(s.template_checklist_id) || (s.asset_id && !guidOrNull(s.asset_id)) || (s.asset_group_id && !guidOrNull(s.asset_group_id))) {
    ctx.log("prestart: a template, asset or asset group id in settings is not a SiteBook id"); return { created: 0, attached: 0 };
  }
  let created = 0, attached = 0, held = 0;
  for (const j of await jobs(ctx)) {
    let rec = await ctx.store.get<PreStart>("prestart", j.id);
    if (rec?.pending) { held++; continue; }  // a create that failed after it was sent: a person checks SiteBook before this job is retried
    if (!rec) {
      // Marked before the call: if the create fails after SiteBook stored it, the next run does not make a second checklist.
      await ctx.store.put("prestart", j.id, { pending: true, swmsAttached: false, created: ctx.now.toISOString() } satisfies PreStart);
      const checkListId = await createPrestart(ctx, s.template_checklist_id, j.id, `${s.job_title_prefix ?? "Pre-start: "}${j.title}`,
        { asset_id: s.asset_id, asset_group_id: s.asset_group_id });
      rec = { checkListId, swmsAttached: false, created: ctx.now.toISOString() };
      await ctx.store.put("prestart", j.id, rec);
      created++;
    }
    if (!rec.swmsAttached && s.swms_id && rec.checkListId) {
      await attachSwms(ctx, rec.checkListId, s.swms_id);
      rec.swmsAttached = true;
      await ctx.store.put("prestart", j.id, rec);
      attached++;
    }
  }
  ctx.log(`prestart: ${created} created, ${attached} SWMS attached${held ? `, ${held} held for a person to check` : ""}`);
  return { created, attached };
}

/** Weekly: a review action for each SWMS whose last review is older than the window, once per window. */
export async function swmsReview(ctx: Ctx<Settings>) {
  const days = ctx.settings.swms_review_days ?? 90;
  let raised = 0;
  for (const w of await swmsList(ctx)) {
    if (!Number.isFinite(w.reviewed) || ctx.now.getTime() - w.reviewed < days * DAY) continue;
    const last = await ctx.store.get<{ raised: string }>("swmsReview", w.id);
    if (last && ctx.now.getTime() - Date.parse(last.raised) < days * DAY) continue;
    await raiseReview(ctx, w.title, new Date(ctx.now.getTime() + 14 * DAY), ctx.settings.swms_review_assignee);
    await ctx.store.put("swmsReview", w.id, { raised: ctx.now.toISOString() });
    raised++;
  }
  ctx.log(`swms-review: ${raised} raised`);
  return { raised };
}

/** Daily: queue a reminder email for each open action due soon. Each action is queued once; a person approves each send. */
export async function reminders(ctx: Ctx<Settings>) {
  const tpl = ctx.settings.reminder_template_id;
  if (!tpl) { ctx.log("reminders: no reminder_template_id set"); return { due_soon: 0 }; }
  const horizon = ctx.now.getTime() + (ctx.settings.reminder_days ?? 2) * DAY;
  let dueSoon = 0;
  for (const a of await openActions(ctx)) {
    if (!Number.isFinite(a.due) || a.due > horizon) continue;
    await queueReminder(ctx, a, tpl);
    dueSoon++;
  }
  ctx.log(`reminders: ${dueSoon} due soon`);
  return { due_soon: dueSoon };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { prestart, "swms-review": swmsReview, reminders };
