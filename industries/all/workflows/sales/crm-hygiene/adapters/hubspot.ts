// HubSpot: contacts are the records. Field names are from HubSpot's official CRM contacts spec (crm-contacts-3):
// POST /crm/v3/objects/contacts/search (filterGroups, properties, sorts, limit, after; results[], paging.next.after),
// GET /crm/v3/objects/contacts/{contactId} (properties), POST /crm/v3/objects/contacts/batch/update (inputs[].id,
// inputs[].properties), POST /crm/v3/objects/contacts/merge (primaryObjectId, objectIdToMerge).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Contact, type Finding, type Settings, ID, tidy } from "../types.ts";

const H = "hubspot" as const;
const PAGE = 100;
const SEARCH = "crm-contacts-3.post-/crm/v3/objects/contacts/search_doSearch";
const GET = "crm-contacts-3.get-/crm/v3/objects/contacts/{contactId}_getById";
const BATCH_UPDATE = "crm-contacts-3.post-/crm/v3/objects/contacts/batch/update_update";
const MERGE = "crm-contacts-3.post-/crm/v3/objects/contacts/merge_merge";

export const hubspot: Adapter = {
  id: H,

  async page(ctx: Ctx<Settings>, cursor?: string) {
    if (cursor !== undefined && !ID.test(cursor)) throw new Error("crm-hygiene: hubspot cursor must be digits");
    const r = await ctx.draft<any>({ platform: H, op: SEARCH, summary: "read a page of contacts that hold an email",
      input: { body: { filterGroups: [{ filters: [{ propertyName: "email", operator: "HAS_PROPERTY" }] }], properties: ["email"],
        sorts: ["createdate"], limit: PAGE, after: cursor ?? "0" } } });
    const items: Contact[] = (Array.isArray(r.data?.results) ? r.data.results : [])
      .filter((c: any) => ID.test(String(c?.id ?? "")))
      .map((c: any) => ({ id: String(c.id), emails: typeof c.properties?.email === "string" ? [c.properties.email] : [], created: String(c.createdAt ?? "") }));
    const next = r.data?.paging?.next?.after;
    return { items, next: next ? String(next) : undefined };
  },

  async queueMerge(ctx: Ctx<Settings>, f: Finding, key: string) {
    if (!ID.test(f.id) || !f.with || !ID.test(f.with)) throw new Error("crm-hygiene: merge needs two plain record ids");
    return ctx.queue({ platform: H, op: MERGE, key, summary: f.summary,
      input: { body: { primaryObjectId: f.with, objectIdToMerge: f.id } } }, f.summary);
  },

  async queueTidy(ctx: Ctx<Settings>, f: Finding, key: string) {
    if (!ID.test(f.id)) throw new Error("crm-hygiene: tidy needs a plain record id");
    const r = await ctx.draft<any>({ platform: H, op: GET, summary: `re-read contact ${f.id} before tidying its email`,
      input: { params: { contactId: f.id, properties: ["email"] } } });
    const cur = r.data?.properties?.email;
    if (typeof cur !== "string") return undefined;
    const next = tidy(cur);
    if (next === cur) return undefined;
    const summary = `Tidy the email address on contact ${f.id} (trim and lowercase)`;
    return ctx.queue({ platform: H, op: BATCH_UPDATE, key, summary,
      input: { body: { inputs: [{ id: f.id, properties: { email: next } }] } } }, summary);
  },
};
