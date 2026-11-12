// SiteBook: the safety paperwork record. Field names come from SiteBook's developer docs:
// POST /v1/checklists takes CheckListId, JobId, Title; POST /v1/checklists/{checkListId}/swms takes SwmsId;
// POST /v1/actions takes ActionId (client-supplied), ActionRequired, DueDate, AssignedToPersonnelId;
// POST /v1/actions/{actionId}/email takes EmailTemplateId. Only the operations listed in workflow.json run from a cron.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, guid, guidOrNull, rows, first, newId } from "../types.ts";

const P = "sitebook";

/** A read through the draft gate. */
async function read(ctx: Ctx<Settings>, op: string): Promise<any> {
  return (await ctx.draft<any>({ platform: P, op, summary: `read ${op}`, input: {} })).data;
}

/** Jobs from SiteBook. Records without a usable id are dropped. */
export async function jobs(ctx: Ctx<Settings>): Promise<{ id: string; title: string }[]> {
  const out: { id: string; title: string }[] = [];
  for (const j of rows(await read(ctx, "docs.get_v1_jobs"), "jobs").slice(0, 100)) {
    const id = guidOrNull(j.JobId ?? j.Id);
    if (id) out.push({ id, title: String(j.Title ?? j.Name ?? "Job").slice(0, 120) });
  }
  return out;
}

/** Open actions with their due date (NaN when SiteBook gives none). */
export async function openActions(ctx: Ctx<Settings>): Promise<{ id: string; title: string; due: number }[]> {
  const out: { id: string; title: string; due: number }[] = [];
  for (const a of rows(await read(ctx, "docs.get_v2_actions"), "actions")) {
    const id = guidOrNull(a.ActionId ?? a.Id);
    if (id && a.Active !== false) out.push({ id, title: String(a.ActionRequired ?? "Action").slice(0, 160), due: Date.parse(String(a.DueDate ?? "")) });
  }
  return out;
}

/** SWMS in the library with the date each was last reviewed (NaN when unknown). */
export async function swmsList(ctx: Ctx<Settings>): Promise<{ id: string; title: string; reviewed: number }[]> {
  const out: { id: string; title: string; reviewed: number }[] = [];
  for (const s of rows(await read(ctx, "docs.get_v1_swms"), "swms")) {
    const id = guidOrNull(s.SwmsId ?? s.Id);
    if (id) out.push({ id, title: String(s.Title ?? s.Name ?? "SWMS").slice(0, 160), reviewed: Date.parse(String(s.ReviewedOn ?? "")) });
  }
  return out;
}

/** Create a pre-start checklist from the template for one job. Returns the new checklist id. SiteBook needs an AssetId or an
 *  AssetGroupId on create; the caller passes whichever the business set. */
export async function createPrestart(ctx: Ctx<Settings>, templateId: string, jobId: string, title: string,
                                     asset: { asset_id?: string; asset_group_id?: string }): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "docs.post_v1_checklists", summary: `pre-start checklist: ${title}`,
    input: { body: { CheckListId: guid(templateId), JobId: guid(jobId), Title: title.slice(0, 200),
                     ...(asset.asset_id ? { AssetId: guid(asset.asset_id) } : {}),
                     ...(asset.asset_group_id ? { AssetGroupId: guid(asset.asset_group_id) } : {}) } } });
  return guid(first(r.data, "checkLists")?.CheckListId);
}

/** Attach a SWMS to a checklist (SiteBook ignores a SWMS already attached). */
export async function attachSwms(ctx: Ctx<Settings>, checklistId: string, swmsId: string): Promise<void> {
  await ctx.draft({ platform: P, op: "docs.post_v1_checklists_checkListId_swms", summary: "attach SWMS to pre-start checklist",
    input: { params: { checkListId: guid(checklistId) }, body: { SwmsId: guid(swmsId) } } });
}

/** An internal review action for a SWMS. The client supplies the ActionId, so a retry of the same call cannot make a second one. */
export async function raiseReview(ctx: Ctx<Settings>, title: string, due: Date, assignee?: string): Promise<string> {
  const id = newId();
  await ctx.draft({ platform: P, op: "docs.post_v1_actions", summary: `review action: ${title}`,
    input: { body: { ActionId: id, ActionRequired: `Review SWMS: ${title}`.slice(0, 500), DueDate: due.toISOString(),
                     ...(assignee ? { AssignedToPersonnelId: guid(assignee) } : {}) } } });
  return id;
}

/** Queue the reminder email for one open action. It is sent only when a person approves it. */
export function queueReminder(ctx: Ctx<Settings>, a: { id: string; title: string; due: number }, templateId: string) {
  const when = Number.isFinite(a.due) ? new Date(a.due).toISOString().slice(0, 10) : "date not set";
  return ctx.queue({ platform: P, op: "docs.post_v1_actions_actionId_email", key: `remind:${a.id}`,
    summary: `reminder email for action "${a.title}" (due ${when})`,
    input: { params: { actionId: guid(a.id) }, body: { EmailTemplateId: guid(templateId) } } });
}
