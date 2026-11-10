// The safety paperwork workflow's three crons. Each reads SiteBook and drafts internal records; the only outbound
// action (a reminder email) is queued for approval. Judgment (writing a SWMS for a new task, close-out photos,
// the handover pack) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings } from "./types.ts";
import { DAY, guidOrNull } from "./types.ts";
import * as pc from "./adapters/procore.ts";
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

type Seen = { first: string; recordable: boolean; closed?: string };

/** Daily: record each Procore incident once (open, recordable or closed since the last run) and log what is new. Reads only; nothing is sent. */
export async function incidents(ctx: Ctx<Settings>) {
  if (!ctx.settings.procore) { ctx.log("incidents: no procore settings; nothing to read"); return { new_open: 0, recordable: 0 }; }
  let newOpen = 0, recordable = 0, closed = 0;
  const failed: string[] = [];
  for (const p of pc.projects(ctx)) {
    let list: Awaited<ReturnType<typeof pc.incidents>>;
    try { list = await pc.incidents(ctx, p.id); } catch (e) { failed.push(`${p.name}: ${(e as Error).message}`); continue; }
    for (const i of list) {
      const key = `${p.id}:${i.id}`, was = await ctx.store.get<Seen>("incidents", key);
      if (!was && i.open) { newOpen++; if (i.recordable) recordable++; ctx.log(`incidents: new open incident${i.number ? " #" + i.number : ""} on ${p.name}${i.recordable ? " (recordable)" : ""}`); }
      if (!was) await ctx.store.put("incidents", key, { first: ctx.now.toISOString(), recordable: i.recordable, closed: i.open ? undefined : ctx.now.toISOString() } satisfies Seen);
      else if (!i.open && !was.closed) { await ctx.store.put("incidents", key, { ...was, closed: ctx.now.toISOString() }); closed++; }
    }
  }
  ctx.log(`incidents: ${newOpen} new open (${recordable} recordable), ${closed} closed since last run`);
  if (failed.length) throw new Error(`incidents: ${failed.length} project(s) not read, the rest were: ${failed.join("; ")}`);
  return { new_open: newOpen, recordable, closed };
}

/** Daily: queue one reminder email for each open Procore inspection past its due date, once per due date. A person approves each send. */
export async function inspectionReminders(ctx: Ctx<Settings>) {
  const s = ctx.settings.procore;
  if (!s) { ctx.log("inspections: no procore settings; nothing to read"); return { overdue: 0 }; }
  const raw = s.reminder_distribution_ids ?? [];
  if (raw.some((x) => !/^[1-9]\d{0,11}$/.test(String(x)))) throw new Error("inspections: reminder_distribution_ids must be Procore integer ids as digit strings");
  const ids = raw.map(Number);
  if (!ids.length) { ctx.log("inspections: no reminder_distribution_ids set; nothing is queued"); return { overdue: 0 }; }
  let overdue = 0;
  const failed: string[] = [];
  for (const p of pc.projects(ctx)) {
    let list: Awaited<ReturnType<typeof pc.inspections>>;
    try { list = await pc.inspections(ctx, p.id); } catch (e) { failed.push(`${p.name}: ${(e as Error).message}`); continue; }
    for (const i of list) {
      if (!i.open || !Number.isFinite(i.due) || i.due >= ctx.now.getTime()) continue;
      const key = `inspection:${p.id}:${i.id}:${new Date(i.due).toISOString().slice(0, 10)}`;
      if (await ctx.store.get("inspectionReminders", key)) continue;
      const label = `${i.identifier ? i.identifier + " " : ""}${i.name}`.trim();
      await pc.queueInspectionEmail(ctx, { project: p.id, id: i.id, key, summary: `Procore email: inspection "${label}" on ${p.name} is past due`,
        subject: `Inspection overdue: ${label}`,
        body: `This inspection was due ${new Date(i.due).toISOString().slice(0, 10)} and is still ${i.deficient ? `open with ${i.deficient} deficient item${i.deficient === 1 ? "" : "s"}` : "open"}. Please complete it in Procore.`,
        status: i.status, distribution_ids: ids });
      await ctx.store.put("inspectionReminders", key, { queued: ctx.now.toISOString() });
      overdue++;
    }
  }
  ctx.log(`inspections: ${overdue} overdue queued`);
  if (failed.length) throw new Error(`inspections: ${failed.length} project(s) not read, the rest were: ${failed.join("; ")}`);
  return { overdue };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { prestart, "swms-review": swmsReview, reminders, incidents, inspections: inspectionReminders };
