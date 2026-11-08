// GoHighLevel: where the lost deals live (opportunities with status lost). Field names come from the vendor's official
// spec (opportunities.json): GET /opportunities/search (status, location_id, pipeline_id, page, limit; response
// opportunities[] with id, name, monetaryValue, lostReasonId, lastStatusChangeAt, pipelineId; meta.nextPage),
// GET /opportunities/lost-reason (locationId; response lostReasons[] with id, name) and
// PUT /opportunities/{id}/status (body status: open, won, lost, abandoned).
import { type Ctx_, type Deal, type Settings, GHL_ID, clip, ghlId, round2 } from "../types.ts";

const P = "gohighlevel";
const MAX_PAGES = 20;
const okId = (v: unknown) => GHL_ID.test(String(v ?? ""));

/** Lost reasons for this location, as id to name. */
export async function lostReasons(ctx: Ctx_): Promise<Record<string, string>> {
  const r = await ctx.draft<any>({ platform: P, op: "opportunities.get-lost-reason", summary: "read lost reasons",
    input: { params: { locationId: ghlId(ctx.settings.locationId, "location id") } } });
  const out: Record<string, string> = {};
  for (const x of r.data?.lostReasons ?? []) if (okId(x?.id)) out[String(x.id)] = clip(x.name, 120);
  return out;
}

/** Every opportunity with the given status, read page by page. Customer text is data, clipped on read. */
export async function deals(ctx: Ctx_, status: "lost" | "won"): Promise<Deal[]> {
  const out: Deal[] = [];
  const pipeline = ctx.settings.pipeline_id ? ghlId(ctx.settings.pipeline_id, "pipeline id") : undefined;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params: Record<string, unknown> = { location_id: ghlId(ctx.settings.locationId, "location id"), status, page, limit: 100 };
    if (pipeline) params.pipeline_id = pipeline;
    const r = await ctx.draft<any>({ platform: P, op: "opportunities.search-opportunity", summary: `read ${status} opportunities, page ${page}`, input: { params } });
    for (const o of r.data?.opportunities ?? []) {
      if (!okId(o?.id)) continue;
      out.push({
        id: String(o.id), name: clip(o.name, 120) || "Untitled opportunity", value: Number(o.monetaryValue) || 0, status,
        changed_at: String(o.lastStatusChangeAt ?? o.updatedAt ?? ""), created_at: o.createdAt ? String(o.createdAt) : undefined,
        lost_reason_id: okId(o.lostReasonId) ? String(o.lostReasonId) : undefined, pipeline_id: okId(o.pipelineId) ? String(o.pipelineId) : undefined,
      });
    }
    if (!r.data?.meta?.nextPage) break;
  }
  return out;
}

/** Queue a re-open of a lost deal (status back to open). Live: a person approves it in the CRM shell. */
export function queueReopen(ctx: Ctx_, d: Deal): Promise<string> {
  return ctx.queue({ platform: P, op: "opportunities.update-opportunity-status", key: `reopen:${d.id}`,
    input: { params: { id: ghlId(d.id, "opportunity id") }, body: { status: "open" } },
    summary: `Re-open lost deal ${d.name} (value $${round2(d.value).toLocaleString("en-AU")}) for another try` });
}
