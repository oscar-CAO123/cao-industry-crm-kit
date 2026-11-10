// Rex: the listing a vendor report is about. Reads only. Rex is an RPC API: every call is a POST to https://{host}/v1/rex/<service>/<method>
// (api-docs.rexsoftware.com, read 11 Nov 2026). listings.read takes { id } and answers { result }, where result carries listing_adverts
// [{ advert_type, advert_heading }], price_advertise_as and property { system_search_key } (the address line). Open homes are calendar events
// in Rex, but the page does not show how an open home is told apart from other events or linked to a listing in a search, so open homes are
// not read: the figures say so, and the report leaves the open home section out rather than say there were none. Rex has no note on a listing
// in the pages read, so nothing is written.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings, Vendor, PropertyFigures } from "../types.ts";

const P = "rex";
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

export const rex = {
  id: P,
  async figures(ctx: Ctx<Settings>, v: Vendor): Promise<PropertyFigures> {
    const id = Number(v.property_id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("rex: bad listing id");
    const r = await ctx.draft<any>({ platform: P, op: "listings.read", summary: `read listing ${id}`, input: { params: { id } } });
    if (r.data?.error) throw new Error(`rex: read listing ${id} returned an error`);
    const x = r.data?.result;
    if (!x || typeof x !== "object") throw new Error(`rex: listing ${id} did not come back as a record`);
    const adverts: any[] = Array.isArray(x.listing_adverts) ? x.listing_adverts : [];
    const heading = clean((adverts.find((a) => a?.advert_type === "internet") ?? adverts[0])?.advert_heading, 200);
    return { property_id: id, sale_life_id: 0, heading, address: clean(x.property?.system_search_key, 200), price: clean(x.price_advertise_as, 80),
      open_homes: [], open_homes_known: false, as_of: ctx.now.toISOString() };
  },
  /** Rex has no note on a listing in the pages read, so no activity note is written. */
  async activityNote(): Promise<void> {},
};
