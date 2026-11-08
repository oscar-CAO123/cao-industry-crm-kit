// Domain (developer.domain.com.au): the listing search, suburb statistics, nearby schools and the enquiry to an agent.
// Field names come from the vendor's spec (endpoint-map/raw/domain): the search body listingType and locations,
// the response listing.id and listing.propertyDetails, and the enquiry body. Anything not in that spec is not used.
// The enquiry is a live operation: this adapter only builds it, and the runtime queues it for a person to approve.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Candidate, type Settings, STATES, candidateKey } from "../types.ts";

const P = "domain";
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const PHONE = /^\+?[0-9 ]{8,20}$/;
const SUBURB = /^[A-Za-z][A-Za-z '.-]{0,59}$/;
const POSTCODE = /^\d{4}$/;
const LISTING_ID = /^\d{1,20}$/;

/** Text from the vendor or the owner: control characters out, length capped. Plain text only, never HTML. */
export const plain = (v: unknown, max: number, keepNewlines = false) => {
  const pattern = keepNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return String(v ?? "").replace(pattern, " ").slice(0, max).trim();
};

export function validSettings(s: Settings): void {
  if (!["Sale", "Rent"].includes(s.search?.listing_type)) throw new Error("site-sourcing: listing_type must be Sale or Rent");
  const locs = s.search?.locations ?? [];
  if (!locs.length || locs.length > 20) throw new Error("site-sourcing: set 1 to 20 locations");
  for (const l of locs) {
    if (!(STATES as readonly string[]).includes(String(l.state).toUpperCase())) throw new Error(`site-sourcing: bad state ${plain(l.state, 10)}`);
    if (!SUBURB.test(String(l.suburb ?? ""))) throw new Error(`site-sourcing: bad suburb ${plain(l.suburb, 60)}`);
    if (l.postcode && !POSTCODE.test(l.postcode)) throw new Error("site-sourcing: bad postcode");
  }
}

export function validSender(s: Settings): NonNullable<Settings["enquiry"]>["sender"] {
  const x = s.enquiry?.sender;
  if (!x) throw new Error("site-sourcing: no enquiry sender in settings");
  if (!x.firstName?.trim() || !x.lastName?.trim() || x.firstName.length > 50 || x.lastName.length > 50) throw new Error("site-sourcing: sender name missing or too long");
  if (!EMAIL.test(x.email ?? "")) throw new Error("site-sourcing: sender email is not valid");
  if (!PHONE.test(x.phoneNumber ?? "")) throw new Error("site-sourcing: sender phone is not valid");
  if (!POSTCODE.test(x.postcode ?? "")) throw new Error("site-sourcing: sender postcode is not valid");
  return x;
}

/** One search request per configured location: residential listings for sale or rent, first page only. */
export async function searchLocation(ctx: Ctx<Settings>, loc: Settings["search"]["locations"][number]): Promise<unknown[]> {
  const body = {
    listingType: ctx.settings.search.listing_type,
    locations: [{ state: String(loc.state).toUpperCase(), region: "", area: "", suburb: loc.suburb, postCode: loc.postcode ?? "", includeSurroundingSuburbs: false }],
  };
  const r = await ctx.draft<unknown[]>({ platform: P, op: "docs.post_v1_listings_residential_search", summary: `search ${loc.suburb} ${loc.state}`, input: { body } });
  if (r.status >= 300) throw new Error(`site-sourcing: search returned ${r.status}`);
  return Array.isArray(r.data) ? r.data : [];
}

/** A PropertyListing becomes a candidate. Project groupings are skipped (their child listings are not read). */
export function parseListing(item: any, now: Date): Candidate | undefined {
  if (!item || item.type !== "PropertyListing" || !item.listing) return undefined;
  const l = item.listing, d = l.propertyDetails ?? {};
  const id = String(l.id ?? "");
  if (!LISTING_ID.test(id)) return undefined;
  const lat = Number(d.latitude), lng = Number(d.longitude), area = Number(d.landArea);
  return {
    key: candidateKey(id), platform: P, listing_id: id,
    address: plain(d.displayableAddress, 200), state: String(d.state ?? "").toUpperCase(), suburb: plain(d.suburb, 60), postcode: String(d.postcode ?? ""),
    latitude: Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : undefined,
    longitude: Number.isFinite(lng) && Math.abs(lng) <= 180 ? lng : undefined,
    property_type: plain(d.propertyType, 40) || undefined,
    land_area: Number.isFinite(area) && area > 0 ? area : undefined,
    headline: plain(l.headline, 200) || undefined,
    status: "new", found: now.toISOString(),
  };
}

/** Keeps a candidate that passes the owner's type and land-area filters. */
export function matches(s: Settings, c: Candidate): boolean {
  const types = (s.search.property_types ?? []).map((t) => t.toLowerCase());
  if (types.length && !types.includes(String(c.property_type ?? "").toLowerCase())) return false;
  if (s.search.min_land_area && c.land_area !== undefined && c.land_area < s.search.min_land_area) return false;
  return true;
}

/** Suburb performance statistics and schools near the site. Zoning, overlays and title are not in Domain's docs. */
export async function deskFacts(ctx: Ctx<Settings>, c: Candidate): Promise<NonNullable<Candidate["desk"]>> {
  if (!STATES.includes(c.state as any) || !SUBURB.test(c.suburb) || !POSTCODE.test(c.postcode)) throw new Error("site-sourcing: candidate location text is not usable");
  const sp = await ctx.draft<unknown>({ platform: P, op: "docs.get_v2_suburbPerformanceStatistics_state_suburb_postcode", summary: `suburb stats ${c.suburb}`,
    input: { params: { state: c.state, suburb: c.suburb, postcode: c.postcode } } });
  let schools: unknown = null;
  if (c.latitude !== undefined && c.longitude !== undefined) {
    const r = await ctx.draft<unknown>({ platform: P, op: "docs.get_v2_schools_latitude_longitude", summary: `schools near ${c.listing_id}`,
      input: { params: { latitude: String(c.latitude), longitude: String(c.longitude) } } });
    schools = r.status < 300 ? r.data : null;
  }
  return { suburb_performance: sp.status < 300 ? sp.data : null, schools };
}

/** The enquiry body, from the vendor's enquiry spec. Recipient and template are chosen by Domain from the listing id. */
export function enquiryBody(s: Settings, c: Candidate) {
  const sender = validSender(s);
  if (!LISTING_ID.test(c.listing_id)) throw new Error("site-sourcing: bad listing id");
  const fill = (t: string) => t.split("{address}").join(c.address || "the property");
  return {
    deliveryMethod: "email",
    enquiryType: "listing",
    referenceId: c.listing_id,
    sender: { firstName: plain(sender.firstName, 50), lastName: plain(sender.lastName, 50), email: sender.email, phoneNumber: sender.phoneNumber.trim(), postcode: sender.postcode },
    subject: plain(fill(s.enquiry?.subject ?? "Enquiry about {address}"), 150),
    message: plain(fill(s.enquiry?.message ?? ""), 2000, true),
  };
}
