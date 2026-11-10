// Pipedrive: the referred lead, and the deal it becomes. Fields come from Pipedrive's official specs:
// v1 GET /leads and GET /leads/{id} (label_ids are lead label UUIDs; custom fields are top-level keys named by their hash);
// v2 GET /deals (updated_since in RFC 3339; source_lead_id links a deal to the lead it came from; stage_id is an integer).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { UUID, type Settings } from "../types.ts";

type Row = Record<string, any>;
const rows = (body: any): Row[] => (Array.isArray(body?.data) ? body.data : []);

/** Open leads that carry the referral label. Reads one page of 100. */
export async function referralLeads(ctx: Ctx<Settings>): Promise<Row[]> {
  const label = ctx.settings.pipedrive.referral_label_id;
  const r = await ctx.draft<any>({ platform: "pipedrive", op: "docs_api_v1.getLeads", summary: "read open leads",
    input: { params: { limit: 100 } } });
  return rows(r.data).filter((l) => UUID.test(String(l.id ?? "")) && Array.isArray(l.label_ids) && l.label_ids.includes(label));
}

/** One lead by id, for a referral whose partner email was missing when it first arrived. */
export async function lead(ctx: Ctx<Settings>, id: string): Promise<Row | undefined> {
  if (!UUID.test(id)) return undefined;
  const r = await ctx.draft<any>({ platform: "pipedrive", op: "docs_api_v1.getLead", summary: `read lead ${id}`,
    input: { params: { id } } });
  return r.data?.data ?? undefined;
}

const PAGE = 100, MAX_PAGES = 50;
const CURSOR = /^[A-Za-z0-9_=|.-]{1,500}$/;

/** Deals changed since a time (RFC 3339) that came from a lead. Follows next_cursor to the last page, at most 50 pages. */
export async function dealsSince(ctx: Ctx<Settings>, since: string): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error("referral-partners: more than 5000 deals changed since the last run; nothing was marked done");
    const r = await ctx.draft<any>({ platform: "pipedrive", op: "openapi-v2.getDeals", summary: "read a page of deals changed since last run",
      input: { params: { updated_since: since, limit: PAGE, ...(cursor ? { cursor } : {}) } } });
    out.push(...rows(r.data).filter((d) => Number.isInteger(d.id) && Number.isInteger(d.stage_id)
      && typeof d.source_lead_id === "string" && UUID.test(d.source_lead_id)));
    const next = r.data?.additional_data?.next_cursor;
    if (!next) return out;
    if (!CURSOR.test(String(next))) throw new Error("referral-partners: Pipedrive cursor is not a plain token");
    cursor = String(next);
  }
}
