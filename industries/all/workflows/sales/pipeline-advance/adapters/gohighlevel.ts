// GoHighLevel: opportunities are the deals. Field names are from GoHighLevel's official OpenAPI spec (opportunities):
// GET /opportunities/search (location_id, pipeline_id, status, startAfter, startAfterId, limit; opportunities[], meta.startAfter,
// meta.startAfterId), GET /opportunities/{id} (opportunity), and PUT /opportunities/{id} (pipelineId, pipelineStageId).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Deal, type Settings, ID, CURSOR, clip, latest } from "../types.ts";

const P = "gohighlevel" as const;
const SEARCH = "opportunities.search-opportunity";
const GET = "opportunities.get-opportunity";
const UPDATE = "opportunities.update-opportunity";
const PAGE = 100;

const toDeal = (o: any): Deal | undefined => {
  const id = String(o?.id ?? "");
  if (!ID.test(id)) return undefined;
  return { id, title: clip(o.name, 120), stage: String(o.pipelineStageId ?? ""), status: String(o.status ?? ""),
    lastChange: latest(o.lastActionDate, o.lastStageChangeAt, o.updatedAt) };
};

export const gohighlevel: Adapter = {
  id: P,

  async page(ctx: Ctx<Settings>, cursor?: string) {
    if (cursor !== undefined && !CURSOR.test(cursor)) throw new Error("pipeline-advance: GoHighLevel cursor is not a plain token");
    const [startAfter, startAfterId] = cursor ? cursor.split("|") : [];
    const r = await ctx.draft<any>({ platform: P, op: SEARCH, summary: "read a page of open opportunities",
      input: { params: { location_id: String(ctx.settings.location_id), pipeline_id: ctx.settings.pipeline_id, status: "open", limit: PAGE,
        ...(cursor ? { startAfter, startAfterId } : {}) } } });
    const items = (Array.isArray(r.data?.opportunities) ? r.data.opportunities : []).map(toDeal).filter((d: Deal | undefined): d is Deal => !!d);
    const m = r.data?.meta;
    const next = items.length && m?.startAfter && m?.startAfterId ? `${m.startAfter}|${m.startAfterId}` : undefined;
    return { items, next: next && CURSOR.test(next) ? next : undefined };
  },

  async get(ctx: Ctx<Settings>, id: string) {
    if (!ID.test(id)) return undefined;
    const r = await ctx.draft<any>({ platform: P, op: GET, summary: `re-read opportunity ${id}`, input: { params: { id } } });
    return toDeal(r.data?.opportunity);
  },

  async queueMove(ctx: Ctx<Settings>, d: Deal, to: string, key: string, summary: string) {
    if (!ID.test(d.id) || !ID.test(to)) throw new Error("pipeline-advance: GoHighLevel move needs plain ids");
    return ctx.queue({ platform: P, op: UPDATE, key, summary,
      input: { params: { id: d.id }, body: { pipelineId: ctx.settings.pipeline_id, pipelineStageId: to } } }, summary);
  },
};
