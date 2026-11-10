// Rex: the listing a vendor report is about. Reads only. Rex is an RPC API: every call is a POST to https://{host}/v1/rex/<service>/<method>
// (api-docs.rexsoftware.com, read 11 Nov 2026). listings.read takes { id } and answers { result }. In the page's sample the result carries
// price_advertise_as and property { system_search_key } (the address line) at the top, and under result.related: listing_adverts
// [{ advert_type, advert_heading }] and listing_events [{ event_type, event_date, event_time, event_duration_minutes }], where an open home
// has event_type "open_home". The date and time carry no zone in the sample, so an open home is kept as that local date and time.
// A reply with no related.listing_events list leaves open homes unread (open_homes_known false): the report then says nothing about them.
// Rex has no note on a listing in the pages read, so nothing is written.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings, Vendor, PropertyFigures, OpenHome } from "../types.ts";

const P = "rex";
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}(:\d{2})?$/;

export const rex = {
  id: P,
  async figures(ctx: Ctx<Settings>, v: Vendor): Promise<PropertyFigures> {
    const id = Number(v.property_id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("rex: bad listing id");
    const r = await ctx.draft<any>({ platform: P, op: "listings.read", summary: `read listing ${id}`, input: { params: { id } } });
    if (r.data?.error) throw new Error(`rex: read listing ${id} returned an error`);
    const x = r.data?.result;
    if (!x || typeof x !== "object") throw new Error(`rex: listing ${id} did not come back as a record`);
    const adverts: any[] = Array.isArray(x.related?.listing_adverts) ? x.related.listing_adverts : [];
    const heading = clean((adverts.find((a) => a?.advert_type === "internet") ?? adverts[0])?.advert_heading, 200);
    const events = x.related?.listing_events;
    const days = ctx.settings.vaultre?.open_home_days ?? 7;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const from = day(ctx.now.getTime() - days * 864e5), to = day(ctx.now.getTime());
    const open_homes: OpenHome[] = [];
    if (Array.isArray(events)) for (const e of events) {
      if (e?.event_type !== "open_home" || !DATE.test(String(e.event_date)) || String(e.event_date) < from || String(e.event_date) > to) continue;
      const time = TIME.test(String(e.event_time)) ? String(e.event_time) : "";
      const mins = Number(e.event_duration_minutes);
      open_homes.push({ id: Number.isSafeInteger(Number(e.id)) ? Number(e.id) : 0, start: `${e.event_date}${time ? " " + time.slice(0, 5) : ""}`,
        end: time && Number.isFinite(mins) && mins > 0 ? `${e.event_date} ${new Date(Date.UTC(2000, 0, 1, +time.slice(0, 2), +time.slice(3, 5) + mins)).toISOString().slice(11, 16)}` : "" });
    }
    return { property_id: id, sale_life_id: 0, heading, address: clean(x.property?.system_search_key, 200), price: clean(x.price_advertise_as, 80),
      open_homes, open_homes_known: Array.isArray(events), as_of: ctx.now.toISOString() };
  },
  /** Rex has no note on a listing in the pages read, so no activity note is written. */
  async activityNote(): Promise<void> {},
};
