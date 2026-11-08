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

/** Contacts tagged as applicants and updated since the last run (first page only). */
export async function applicantContacts(ctx: Ctx<Settings>, since?: string): Promise<Applicant[]> {
  const r = cfg(ctx);
  const res = await ctx.draft<any>({ platform: "re-leased", op: "Contacts_Get", summary: "read applicant contacts", input: { params: {
    companyId: r.company_id, ...(r.applicant_tag ? { tag: clean(r.applicant_tag, 60) } : {}), ...(since ? { updatedAfterDate: since } : {}), includeTags: false } } });
  const rows: any[] = Array.isArray(res.data?.Data) ? res.data.Data : [];
  return rows.filter((c) => UUID.test(String(c?.Id ?? ""))).map((c) => ({
    id: String(c.Id), name: clean(c.Name || `${c.FirstName ?? ""} ${c.LastName ?? ""}`, 120) || "Applicant",
    email: EMAIL.test(String(c.Email ?? "")) ? String(c.Email) : undefined, status: "new" as const, received: String(c.UpdatedDateTime ?? ctx.now.toISOString()),
  }));
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
