// The field-forms workflow's three crons. Each is deterministic: intake and checklists read, report queues.
// Judgment (reading photos, deciding what a form means) belongs to the agent skill in SKILL.md, not these crons.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { ChecklistRow, FormRow, Settings } from "./types.ts";
import { EMAIL, clean } from "./types.ts";
import * as fw from "./adapters/fieldwire.ts";

const DAY = 864e5, HOUR = 36e5;
const watched = (ctx: Ctx<Settings>) => ctx.settings.fieldwire?.projects ?? [];

/** Every 15 minutes: forms changed in each watched project since the last run, kept as rows. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  let seen = 0, added = 0;
  for (const project of watched(ctx)) {
    const mark = await ctx.store.get<{ at: string }>("watermarks", `forms:${project}`);
    const since = mark?.at ?? new Date(ctx.now.getTime() - DAY).toISOString();
    let latest = since;
    for (const f of await fw.formsUpdatedSince(ctx, project, since)) {
      const prev = await ctx.store.get<FormRow>("forms", f.id);
      if (!prev) added++;
      await ctx.store.put("forms", f.id, { ...f, ...(prev?.carry ? { carry: true } : {}) } satisfies FormRow);
      seen++;
      if (f.updated > latest) latest = f.updated;
    }
    await ctx.store.put("watermarks", `forms:${project}`, { at: latest });
  }
  ctx.log(`intake: ${seen} changed forms, ${added} new`);
  return { seen, added };
}

/** Hourly: the checklists on tasks starting within a day either side of now, counted open or done. Reads only. */
export async function checklists(ctx: Ctx<Settings>) {
  const from = new Date(ctx.now.getTime() - DAY).toISOString(), to = new Date(ctx.now.getTime() + DAY).toISOString();
  let tasks = 0, withOpen = 0;
  for (const project of watched(ctx)) {
    for (const t of await fw.tasksStarting(ctx, project, from, to)) {
      const c = await fw.checklistOf(ctx, project, t.id);
      await ctx.store.put("checklists", t.id, { task: t.id, project, name: t.name, total: c.total, open: c.open, checked_at: ctx.now.toISOString() } satisfies ChecklistRow);
      tasks++;
      if (c.open) withOpen++;
    }
  }
  ctx.log(`checklists: ${tasks} tasks, ${withOpen} with open items`);
  return { tasks, with_open_items: withOpen };
}

/** Daily: queue one PDF email per completed form from the window, for a person to approve. Never sends. */
export async function report(ctx: Ctx<Settings>) {
  const s = ctx.settings.fieldwire;
  const complete = new Set(s?.complete_status_ids ?? []);
  if (!complete.size) { ctx.log("report: no complete_status_ids set, nothing queued"); return { queued: 0 }; }
  const to = (s.report_recipients ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!to.length || to.some((x) => !EMAIL.test(x))) throw new Error("report: report_recipients must be comma-separated email addresses");
  const since = ctx.now.getTime() - (ctx.settings.report_window_hours ?? 24) * HOUR;
  const candidates = Object.values(await ctx.store.list<FormRow>("forms"))
    .filter((f) => complete.has(f.status) && (Date.parse(f.updated) >= since || f.carry === true))
    .sort((a, b) => a.updated.localeCompare(b.updated));
  const cap = s.report_max_per_run ?? 20;
  // Forms the cap leaves behind carry over to the next run, so the 24-hour window cannot drop them.
  for (const f of candidates.slice(cap)) if (!f.carry) await ctx.store.put("forms", f.id, { ...f, carry: true } satisfies FormRow);
  const forms = candidates.slice(0, cap);
  for (const f of forms) {
    const subject = clean(`${ctx.settings.business_name ?? "Completed form"}: ${f.name}`, 200);
    const body = clean(`Attached is the completed form "${f.name}", completed ${f.updated.slice(0, 10)}.`, 1000);
    await fw.queueFormEmail(ctx, f, to, subject, body);
    if (f.carry) { const { carry: _done, ...rest } = f; await ctx.store.put("forms", f.id, rest satisfies FormRow); }
  }
  ctx.log(`report: ${forms.length} completed forms ready for approval`);
  return { queued: forms.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, checklists, report };
