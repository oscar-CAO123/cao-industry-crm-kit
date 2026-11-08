// HubSpot: companies. Searching and upserting companies are internal CRM records, so both are draft operations.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, HS_ID, HS_PROP, clean } from "../types.ts";

const P = "hubspot";
export const COMPANY_SEARCH = "crm-companies-3.post-/crm/v3/objects/companies/search_doSearch";
export const COMPANY_UPSERT = "crm-companies-3.post-/crm/v3/objects/companies/batch/upsert_upsert";
const BATCH = 100;   // HubSpot accepts up to 100 inputs a batch

/** idProperty: match on that property (the value is the Xero ContactID). Without it, id is the HubSpot record id. */
export type Upsert = { id: string; idProperty?: string; properties: Record<string, string> };

/** Companies that do not yet carry a Xero ContactID, up to one batch. */
export async function companiesWithoutXero(ctx: Ctx<Settings>, idProperty: string): Promise<{ id: string; name: string }[]> {
  if (!HS_PROP.test(idProperty)) throw new Error("hubspot: idProperty is not a valid property name");
  const r = await ctx.draft<any>({ platform: P, op: COMPANY_SEARCH, summary: "companies without a Xero contact",
    input: { body: { filterGroups: [{ filters: [{ propertyName: idProperty, operator: "NOT_HAS_PROPERTY" }] }], properties: ["name"], limit: BATCH } } });
  return (r.data?.results ?? [])
    .filter((x: any) => HS_ID.test(String(x.id)))
    .map((x: any) => ({ id: String(x.id), name: clean(x.properties?.name) }))
    .filter((c: { name: string }) => c.name);
}

/** Upsert companies in batches of 100. Every id and property name is checked before it leaves. */
export async function upsertCompanies(ctx: Ctx<Settings>, rows: Upsert[]): Promise<number> {
  const inputs = rows.map((r) => {
    if (r.idProperty) {
      if (!HS_PROP.test(r.idProperty)) throw new Error("hubspot: idProperty is not a valid property name");
    } else if (!HS_ID.test(r.id)) throw new Error("hubspot: company id is not numeric");
    for (const k of Object.keys(r.properties)) if (!HS_PROP.test(k)) throw new Error("hubspot: property name is not valid");
    const properties = { ...r.properties, ...(r.idProperty ? { [r.idProperty]: r.id } : {}) };
    return { id: r.id, ...(r.idProperty ? { idProperty: r.idProperty } : {}), properties };
  });
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    await ctx.draft({ platform: P, op: COMPANY_UPSERT, summary: `upsert ${batch.length} companies`, input: { body: { inputs: batch } } });
  }
  return inputs.length;
}
