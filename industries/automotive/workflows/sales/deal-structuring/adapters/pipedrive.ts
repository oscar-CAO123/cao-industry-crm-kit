// Pipedrive: the CRM where the deal lives. The cron reads deals in the intake stage and adds an internal note (a draft
// operation). Moving a deal to the lender-submitted stage changes a live record, so it is only ever part of an approval.
import type { Act } from "../../../../../../core/workflows/runtime.ts";
import { type Cx, esc } from "../types.ts";

const P = "pipedrive";

export interface PipedriveDeal { id: number; title?: string; value?: number; currency?: string; person_id?: number; org_id?: number; stage_id?: number }

/** Open deals in the intake stage (a read). */
export async function openDeals(ctx: Cx): Promise<PipedriveDeal[]> {
  const pd = ctx.settings.pipedrive;
  const r = await ctx.draft<any>({ platform: P, op: "openapi-v2.getDeals", summary: "read deals in the intake stage", input: { params: {
    pipeline_id: pd.pipeline_id, stage_id: pd.intake_stage_id, status: "open", limit: 50 } } });
  return (r.data?.data ?? []).filter((d: any) => Number.isSafeInteger(d?.id) && d.id > 0);
}

/** An internal note on the deal (a draft operation: it reaches nobody outside the business). */
export async function addNote(ctx: Cx, dealId: number, html: string): Promise<void> {
  await ctx.draft<any>({ platform: P, op: "docs_api_v1.addNote", summary: `internal note on deal ${dealId}`, input: { body: {
    content: html.slice(0, 20000), deal_id: dealId } } });
}

/** The stage move that follows a lender submission. Only ever queued, as the second act of a submission approval. */
export function stageAct(ctx: Cx, dealId: number): Act {
  return { platform: P, op: "openapi-v2.updateDeal", summary: `move deal ${dealId} to lender submitted`,
    input: { params: { id: dealId }, body: { stage_id: ctx.settings.pipedrive.submitted_stage_id } } };
}

/** The note text for a set of drafted lender packs. Every value is escaped. */
export const packNote = (lenders: string[]) =>
  `<p>Finance packs drafted for ${esc(lenders.join(", "))}. Each one waits for approval before it is sent.</p>`;
