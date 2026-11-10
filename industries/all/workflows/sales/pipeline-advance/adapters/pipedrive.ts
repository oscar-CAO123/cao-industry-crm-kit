// Pipedrive: deals are the deals. Field names are from Pipedrive's official v2 spec (openapi-v2): GET /api/v2/deals
// (status, pipeline_id, limit, cursor; data[], additional_data.next_cursor), GET /api/v2/deals/{id} (data), and
// PATCH /api/v2/deals/{id} (stage_id, an integer).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Deal, type Settings, ID, CURSOR, clip, latest } from "../types.ts";

const P = "pipedrive" as const;
const LIST = "openapi-v2.getDeals";
const GET = "openapi-v2.getDeal";
const PATCH = "openapi-v2.updateDeal";
const PAGE = 100;
const NUM = /^[0-9]{1,20}$/;

const toDeal = (d: any): Deal | undefined => {
  const id = String(d?.id ?? "");
  if (!NUM.test(id)) return undefined;
  return { id, title: clip(d.title, 120), stage: String(d.stage_id ?? ""), status: String(d.status ?? ""),
    lastChange: latest(d.update_time, d.stage_change_time, d.add_time) };
};

export const pipedrive: Adapter = {
  id: P,

  async page(ctx: Ctx<Settings>, cursor?: string) {
    if (cursor !== undefined && !CURSOR.test(cursor)) throw new Error("pipeline-advance: Pipedrive cursor is not a plain token");
    const r = await ctx.draft<any>({ platform: P, op: LIST, summary: "read a page of open deals",
      input: { params: { status: "open", pipeline_id: ctx.settings.pipeline_id, limit: PAGE, ...(cursor ? { cursor } : {}) } } });
    const items = (Array.isArray(r.data?.data) ? r.data.data : []).map(toDeal).filter((d: Deal | undefined): d is Deal => !!d);
    const next = r.data?.additional_data?.next_cursor;
    return { items, next: next && CURSOR.test(String(next)) ? String(next) : undefined };
  },

  async get(ctx: Ctx<Settings>, id: string) {
    if (!NUM.test(id)) return undefined;
    const r = await ctx.draft<any>({ platform: P, op: GET, summary: `re-read deal ${id}`, input: { params: { id: Number(id) } } });
    return toDeal(r.data?.data);
  },

  async queueMove(ctx: Ctx<Settings>, d: Deal, to: string, key: string, summary: string) {
    if (!NUM.test(d.id) || !NUM.test(to) || !NUM.test(d.stage)) throw new Error("pipeline-advance: Pipedrive move needs numeric ids");
    // The approval re-reads the deal and is closed unless it is still open at the stage the cron saw.
    return ctx.queue({ platform: P, op: PATCH, key, summary,
      input: { params: { id: Number(d.id) }, body: { stage_id: Number(to) } },
      check: { platform: P, op: GET, input: { params: { id: Number(d.id) } },
        expect: [{ path: "data.stage_id", equals: Number(d.stage) }, { path: "data.status", equals: d.status }] } }, summary);
  },
};
