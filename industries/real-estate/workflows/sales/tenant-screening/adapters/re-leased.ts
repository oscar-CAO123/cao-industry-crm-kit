// Re-Leased: the applicant contacts (read by tag) and the tenancy created once a person approves it.
// Field names come from the vendor's Swagger file (endpoint-map/raw/re-leased/spec): Contacts_Get, Contacts_Get.get,
// and Tenancies_Post with CreateTenancyRequest. Nothing here sends anything; a tenancy is a live operation.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Applicant, UUID, DATE, EMAIL, clean, keyOf } from "../types.ts";

const cfg = (ctx: Ctx<Settings>) => {
  const r = ctx.settings.re_leased;
  if (!r || !UUID.test(String(r.company_id ?? ""))) throw new Error("re_leased.company_id is not set to a GUID");
  if (!UUID.test(String(r.property_id ?? ""))) throw new Error("re_leased.property_id is not set to a GUID");
  return r;
};

const MAX_PAGES = 20;

/** Contacts tagged as applicants and updated since the last run, following MetaData.NextPageUrl up to MAX_PAGES pages.
 *  complete is false when pages remain past the cap, so the caller holds its cursor. */
export async function applicantContacts(ctx: Ctx<Settings>, since?: string): Promise<{ rows: Applicant[]; complete: boolean }> {
  const r = cfg(ctx);
  const out: Applicant[] = [];
  let fromId: string | undefined;
  for (let page = 1; ; page++) {
    const res = await ctx.draft<any>({ platform: "re-leased", op: "Contacts_Get", summary: `read applicant contacts page ${page}`, input: { params: {
      companyId: r.company_id, ...(r.applicant_tag ? { tag: clean(r.applicant_tag, 60) } : {}), ...(since ? { updatedAfterDate: since } : {}),
      ...(fromId ? { fromId } : {}), includeTags: false } } });
    const rows: any[] = Array.isArray(res.data?.Data) ? res.data.Data : [];
    for (const c of rows.filter((x) => UUID.test(String(x?.Id ?? "")))) {
      out.push({ id: String(c.Id), name: clean(c.Name || `${c.FirstName ?? ""} ${c.LastName ?? ""}`, 120) || "Applicant",
        email: EMAIL.test(String(c.Email ?? "")) ? String(c.Email) : undefined, status: "new" as const, received: String(c.UpdatedDateTime ?? ctx.now.toISOString()) });
    }
    const next = res.data?.MetaData?.NextPageUrl;
    if (!next) return { rows: out, complete: true };
    if (page >= MAX_PAGES) return { rows: out, complete: false };
    fromId = new URL(String(next), "https://re-leased.invalid").searchParams.get("fromId") ?? undefined;
    if (!fromId || !UUID.test(fromId)) return { rows: out, complete: false };
  }
}

/** One contact read in full, to confirm the record is usable before a person checks the applicant. */
export async function readContact(ctx: Ctx<Settings>, id: string): Promise<{ email?: string; name?: string } | undefined> {
  if (!UUID.test(id)) throw new Error("re-leased: bad contact id");
  const res = await ctx.draft<any>({ platform: "re-leased", op: "Contacts_Get.get", summary: `read applicant ${keyOf(id)}`, input: { params: { id, includeTags: true } } });
  const d = res.data?.Data;
  const c = Array.isArray(d) ? d[0] : d;
  if (!c) return undefined;
  return { name: clean(c.Name || `${c.FirstName ?? ""} ${c.LastName ?? ""}`, 120) || undefined, email: EMAIL.test(String(c.Email ?? "")) ? String(c.Email) : undefined };
}

/** The tenancy body for a person-approved applicant. Dates must be YYYY-MM-DD and the end must follow the start. */
export function tenancyBody(ctx: Ctx<Settings>, a: Applicant) {
  const r = cfg(ctx);
  const start = a.lease?.start ?? "", end = a.lease?.end ?? "";
  if (!DATE.test(String(start)) || !DATE.test(String(end)) || !(Date.parse(end) > Date.parse(start))) throw new Error(`lease dates for ${keyOf(a.id)} are not a valid range`);
  return {
    PropertyGlobalIdentifier: r.property_id,
    PrimaryContactGlobalIdentifier: a.id,
    Title: clean(`${r.title_prefix ?? "Lease"}: ${a.name}`, 255),
    StartDate: `${start}T00:00:00Z`,
    EndDate: `${end}T00:00:00Z`,
    IsResidential: r.is_residential ?? false,
  };
}
