// HubSpot: contacts are looked up by email address, read only. The search request and its reply are from HubSpot's
// CRM contacts spec (crm-contacts-3): POST /crm/v3/objects/contacts/search with filterGroups[].filters[]
// (propertyName, operator, value), properties, sorts, limit and after; the reply holds results[].id.
// Writing a note on a contact is not built: the note body property and the note-to-contact association type are not
// confirmed in the vendor spec mapped here.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { EMAIL, type Settings } from "../types.ts";

const H = "hubspot" as const;
const SEARCH = "crm-contacts-3.post-/crm/v3/objects/contacts/search_doSearch";
const ID = /^[0-9]{1,20}$/;

/** The HubSpot contact ids that hold this email address (up to five). Reads only. */
export async function contactsFor(ctx: Ctx<Settings>, email: string): Promise<string[]> {
  if (!EMAIL.test(email)) throw new Error("hubspot: bad email for a contact lookup");
  const r = await ctx.draft<any>({ platform: H, op: SEARCH, summary: "look up a contact by email",
    input: { body: { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
      properties: ["email"], sorts: ["createdate"], limit: 5, after: "0" } } });
  return (Array.isArray(r.data?.results) ? r.data.results : [])
    .map((c: any) => String(c?.id ?? ""))
    .filter((x: string) => ID.test(x));
}
