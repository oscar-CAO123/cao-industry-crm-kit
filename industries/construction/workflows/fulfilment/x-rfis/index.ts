// The RFIs workflow's two crons. intake reads; draft creates RFI drafts from the agent's question rows and queues
// the step that opens each one to the designer. Nothing is sent: a person approves every open.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { QuestionRow, RfiRow, Settings } from "./types.ts";
import { ymd } from "./types.ts";
import * as fw from "./adapters/fieldwire.ts";

const DAY = 864e5;
const watched = (ctx: Ctx<Settings>) => ctx.settings.fieldwire?.projects ?? [];

/** Every 15 minutes: RFIs changed in each watched project since the last run, kept as rows. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  let seen = 0, added = 0;
  for (const project of watched(ctx)) {
    const mark = await ctx.store.get<{ at: string }>("watermarks", `rfis:${project}`);
    const since = mark?.at ?? new Date(ctx.now.getTime() - DAY).toISOString();
    let latest = since;
    for (const r of await fw.rfisUpdatedSince(ctx, project, since)) {
      if (!(await ctx.store.get("rfis", r.id))) added++;
      await ctx.store.put("rfis", r.id, r satisfies RfiRow);
      seen++;
      if (r.updated > latest) latest = r.updated;
    }
    await ctx.store.put("watermarks", `rfis:${project}`, { at: latest });
  }
  ctx.log(`intake: ${seen} changed RFIs, ${added} new`);
  return { seen, added };
}

/** Every 30 minutes: each new question becomes an RFI draft with its question text, then a queued open to the designer. */
export async function draft(ctx: Ctx<Settings>) {
  const s = ctx.settings.fieldwire;
  const todo = Object.values(await ctx.store.list<QuestionRow>("questions"))
    .filter((q) => q.status === "new" || q.status === "drafted" || q.status === "needs-assignee" || q.status === "needs-person");
  let created = 0, queued = 0, parked = 0;
  for (const q of todo) {
    // One question's failure parks that question with its reason; the others still run in this pass.
    try {
      if (!q.rfi_id) {
        q.rfi_id = await fw.createRfiDraft(ctx, q.project, q.name);
        await ctx.store.put("questions", q.id, q);     // remember the RFI at once: a rerun never creates a second one
        created++;
      }
      if (!q.question_set) {
        await fw.setQuestion(ctx, q.project, q.rfi_id, q.question);
        q.question_set = true;
      }
      const assignee = q.assignee_user_id ?? s?.designer_user_id;
      if (!assignee) {
        q.status = "needs-assignee"; q.reason = "no designer named and no default designer_user_id in settings";
        await ctx.store.put("questions", q.id, q); parked++;
        continue;
      }
      const due = q.due_date ?? ymd(new Date(ctx.now.getTime() + (s?.default_due_days ?? 7) * DAY));
      await fw.queueRfiOpen(ctx, { project: q.project, id: q.rfi_id, name: q.name }, assignee, due, q.message ?? "Please answer this RFI in Fieldwire.");
      q.status = "queued"; q.reason = undefined;
      await ctx.store.put("questions", q.id, q);
      queued++;
    } catch (e: any) {
      q.status = "needs-person"; q.reason = String(e?.message ?? e).slice(0, 240);
      await ctx.store.put("questions", q.id, q); parked++;   // the RFI id is saved already, so a retry never makes a second RFI
    }
  }
  ctx.log(`draft: ${created} RFI drafts, ${queued} queued to open, ${parked} need an assignee`);
  return { created, queued, needs_assignee: parked };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft };
