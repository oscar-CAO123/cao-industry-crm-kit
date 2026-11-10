// The RFIs workflow's two crons. intake reads; draft creates RFI drafts from the agent's question rows and queues
// the step that opens each one to the designer. Nothing is sent: a person approves every open.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { QuestionRow, RfiRow, Settings } from "./types.ts";
import { ymd } from "./types.ts";
import * as fw from "./adapters/fieldwire.ts";
import * as pc from "./adapters/procore.ts";

const DAY = 864e5;

/** The two RFI systems share one shape. A business sets exactly one of `fieldwire` or `procore` in its settings. */
interface RfiPlatform {
  PLATFORM_NAME: string; MAX_RFI_PAGES: number; QUESTION_ON_CREATE: boolean;
  rfisUpdatedSince(ctx: Ctx<Settings>, project: string, since: string): Promise<{ rows: RfiRow[]; complete: boolean }>;
  createRfiDraft(ctx: Ctx<Settings>, project: string, name: string, question: string): Promise<string>;
  setQuestion(ctx: Ctx<Settings>, project: string, rfiId: string, question: string): Promise<void>;
  queueRfiOpen(ctx: Ctx<Settings>, rfi: { project: string; id: string; name: string }, assignee: number, due: string, message: string): Promise<string>;
}
function platform(ctx: Ctx<Settings>): { api: RfiPlatform; projects: string[]; assignee?: number; dueDays?: number } {
  const { fieldwire: f, procore: p } = ctx.settings;
  if (f && p) throw new Error("rfis: set either fieldwire or procore in settings, not both");
  if (p) return { api: pc as RfiPlatform, projects: p.projects ?? [], assignee: p.default_assignee_id, dueDays: p.default_due_days };
  return { api: fw as RfiPlatform, projects: f?.projects ?? [], assignee: f?.designer_user_id, dueDays: f?.default_due_days };
}

/** Every 15 minutes: RFIs changed in each watched project since the last run, kept as rows. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  const { api, projects } = platform(ctx);
  let seen = 0, added = 0;
  for (const project of projects) {
    const mark = await ctx.store.get<{ at: string }>("watermarks", `rfis:${project}`);
    const since = mark?.at ?? new Date(ctx.now.getTime() - DAY).toISOString();
    let latest = since;
    const got = await api.rfisUpdatedSince(ctx, project, since);
    // A refused list leaves the watermark where it was, so no changed RFI is skipped. A window that stays past the cap is
    // refused on every run until someone narrows it; the log line says so.
    if (!got.complete) { ctx.log(`intake: changed-RFI list refused past ${api.MAX_RFI_PAGES} pages; watermark held`); continue; }
    for (const r of got.rows) {
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
  const { api, assignee: defaultAssignee, dueDays } = platform(ctx);
  const todo = Object.values(await ctx.store.list<QuestionRow>("questions"))
    .filter((q) => q.status === "new" || q.status === "drafted" || q.status === "needs-assignee" || q.status === "needs-person");
  let created = 0, queued = 0, parked = 0;
  for (const q of todo) {
    // One question's failure parks that question with its reason; the others still run in this pass.
    try {
      if (!q.rfi_id) {
        q.rfi_id = await api.createRfiDraft(ctx, q.project, q.name, q.question);
        if (api.QUESTION_ON_CREATE) q.question_set = true;
        await ctx.store.put("questions", q.id, q);     // remember the RFI at once: a rerun never creates a second one
        created++;
      }
      if (!q.question_set) {
        await api.setQuestion(ctx, q.project, q.rfi_id, q.question);
        q.question_set = true;
      }
      const assignee = q.assignee_user_id ?? defaultAssignee;
      if (!assignee) {
        q.status = "needs-assignee"; q.reason = "no designer named and no default assignee in settings";
        await ctx.store.put("questions", q.id, q); parked++;
        continue;
      }
      const due = q.due_date ?? ymd(new Date(ctx.now.getTime() + (dueDays ?? 7) * DAY));
      await api.queueRfiOpen(ctx, { project: q.project, id: q.rfi_id, name: q.name }, assignee, due, q.message ?? `Please answer this RFI in ${api.PLATFORM_NAME}.`);
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
