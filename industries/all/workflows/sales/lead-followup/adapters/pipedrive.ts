// Pipedrive: deals in the watched stages are the leads and quotes. A touch is drafted in Pipedrive as a call activity and a
// note holding the message, for the person to send from Pipedrive mail (no send operation is mapped for this job). A move
// to lost is queued for approval. Field names: openapi-v2 POST /activities (subject, type, deal_id, due_date, done, note),
// docs_api_v1 POST /notes (content, deal_id), openapi-v2 PATCH /deals/{id} (status, lost_reason), docs_api_v1 GET
// /pipelines/{id}/deals (stage_id, limit). Field names are from Pipedrive's official v1 and v2 OpenAPI files.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Found, type Lead, type Settings, type Watch, ID, esc, clip, day } from "../types.ts";

const P = "pipedrive" as const;
const PAGE = 100;

/** The list may arrive bare or inside the usual { success, data } envelope. */
const rows = (body: any): any[] => Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];

export const pipedrive: Adapter = {
  id: P,

  async watched(ctx: Ctx<Settings>, w: Watch) {
    const s = ctx.settings;
    if (!ID.test(s.pipeline_id) || !ID.test(w.stage_id)) throw new Error("lead-followup: pipeline and stage ids must be plain ids");
    const r = await ctx.draft<any>({ platform: P, op: "docs_api_v1.getPipelineDeals", summary: `read deals in stage ${w.stage_id}`,
      input: { params: { id: s.pipeline_id, stage_id: w.stage_id, start: 0, limit: PAGE } } });
    const list = rows(r.data);
    const items: Found[] = list
      .filter((d) => ID.test(String(d?.id ?? "")))
      .map((d) => ({ id: String(d.id), title: clip(d.title, 120), stage_id: String(d.stage_id ?? w.stage_id), status: String(d.status ?? "open") }));
    return { items, truncated: list.length >= PAGE };
  },

  async draftTouch(ctx: Ctx<Settings>, lead: Lead, text: string, n: number) {
    const dealId = Number(lead.id);
    await ctx.draft({ platform: P, op: "openapi-v2.addActivity", summary: `call task for ${lead.key} (touch ${n + 1})`,
      input: { body: { subject: clip(`Follow up: ${lead.title}`, 200), type: "call", deal_id: dealId, due_date: day(ctx.now), done: false, note: esc(text) } } });
    await ctx.draft({ platform: P, op: "docs_api_v1.addNote", summary: `note with the drafted message for ${lead.key} (touch ${n + 1})`,
      input: { body: { content: `<p>Drafted follow-up ${n + 1}, to send from Pipedrive mail:</p><p>${esc(text)}</p>`, deal_id: dealId } } });
  },

  async queueLost(ctx: Ctx<Settings>, lead: Lead, key: string) {
    const reason = clip(ctx.settings.lost_reason ?? "No reply after follow-ups", 200);
    return ctx.queue({ platform: P, op: "openapi-v2.updateDeal", key,
      input: { params: { id: lead.id }, body: { status: "lost", lost_reason: reason } } },
      `Mark "${clip(lead.title, 80)}" lost after no reply`);
  },
};
