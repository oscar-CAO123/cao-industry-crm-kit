// SiteBook: the safety checklists, incidents and corrective actions a construction business keeps in it.
// Operation ids are in core/sdk/platforms/sitebook/ops.json. Field names come from SiteBook's Reporting API docs
// (endpoint-map/raw/sitebook/pages): query filters on the list reads, the path id on report generation, and the
// EmailTemplateId body on the action email. Creating records needs a request schema the docs do not list, so none is built here.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, guid, str, rowsOf, DAY } from "../types.ts";

const P = "sitebook";
const LIMIT = 200;

const read = async <T>(ctx: Ctx<Settings>, op: string, params: Record<string, unknown>, summary: string): Promise<T[]> =>
  rowsOf<T>((await ctx.draft<unknown>({ platform: P, op, summary, input: { params } })).data);

/** Limits a read to the configured job, when one is set and valid. */
const jobFilter = (ctx: Ctx<Settings>): Record<string, string> => {
  const job = guid(ctx.settings.sitebook?.job_id);
  return job ? { JobId: job } : {};
};

/** Open incidents, newest first as SiteBook returns them. */
export const openIncidents = (ctx: Ctx<Settings>) =>
  read<{ IncidentId?: unknown; IncidentNumber?: unknown; IncidentType?: unknown }>(
    ctx, "docs.get_v2_incidents", { Open: "true", Size: LIMIT, ...jobFilter(ctx) }, "read open incidents");

/** Generates the incident report inside SiteBook, for its register. Path id only; no body. */
export async function draftIncidentReport(ctx: Ctx<Settings>, id: string): Promise<void> {
  await ctx.draft({ platform: P, op: "docs.post_v1_incidents_incidentId_report", summary: `incident report for ${id}`,
    input: { params: { incidentId: id } } });
}

/** Checklists completed within the lookback window. Templates are excluded. */
export async function completedChecklists(ctx: Ctx<Settings>) {
  const days = ctx.settings.sitebook?.lookback_days ?? 14;
  const from = new Date(ctx.now.getTime() - days * DAY).toISOString();
  const rows = await read<{ CheckListId?: unknown; Template?: unknown; CompletedOn?: unknown; Title?: unknown }>(
    ctx, "docs.get_v1_checklists", { FromDate: from, Size: LIMIT, ...jobFilter(ctx) }, "read recent checklists");
  return rows.filter((r) => r.Template !== true && !!r.CompletedOn);
}

/** Generates a completed checklist's report inside SiteBook, for its register. Path id only; no body. */
export async function draftChecklistReport(ctx: Ctx<Settings>, id: string): Promise<void> {
  await ctx.draft({ platform: P, op: "docs.post_v1_checklists_checkListId_report", summary: `checklist report for ${id}`,
    input: { params: { checkListId: id } } });
}

/** Corrective actions that are open and past their due date. */
export const overdueActions = (ctx: Ctx<Settings>) =>
  read<{ ActionId?: unknown; DueDate?: unknown; ActionRequired?: unknown }>(
    ctx, "docs.get_v2_actions", { Open: "true", Overdue: "true", Size: LIMIT, ...jobFilter(ctx) }, "read overdue corrective actions");

/** Queues a chase email to the action's recipient. A live operation: it waits for a person to approve it. */
export function queueChase(ctx: Ctx<Settings>, id: string, key: string, due: unknown): Promise<string> {
  const tpl = guid(ctx.settings.sitebook?.email_template_id);
  return ctx.queue({ platform: P, op: "docs.post_v1_actions_actionId_email", key,
    summary: `email overdue corrective action ${id} (due ${str(due, 20)}) to its recipient`,
    input: { params: { actionId: id }, body: tpl ? { EmailTemplateId: tpl } : {} } });
}
