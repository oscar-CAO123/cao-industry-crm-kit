// HubSpot: deals are the unit of a call. Field names come from HubSpot's official CRM specs:
// crm-deals-2026-09 (search, associations, patch), crm-companies-2026-09 (get), crm-notes-2026-09 (create, default association),
// and crm-contacts-3 (get). Reads and the internal note are draft operations; the next-step change is a live operation.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Deal, type Person, type Company, ID, EMAIL, DAY, clip, domainOf } from "../types.ts";

const P = "hubspot" as const;
const DEALS = "crm-deals-2026-09.post-/crm/objects/2026-09/0-3/search_/crm/objects/2026-09-beta/{objectType}/search";
const DEAL_ASSOC = "crm-deals-2026-09.get-/crm/objects/2026-09/0-3/{dealId}/associations/{toObjectType}_/crm/objects/2026-09-beta/{objectType}/{objectId}/associations/{toObjectType}";
const CONTACT = "crm-contacts-3.get-/crm/v3/objects/contacts/{contactId}_getById";
const COMPANY = "crm-companies-2026-09.get-/crm/objects/2026-09/companies/{companyId}_/crm/objects/2026-09-beta/{objectType}/{objectId}";
const NOTE = "crm-notes-2026-09.post-/crm/objects/2026-09/notes_/crm/objects/2026-09-beta/{objectType}";
const NOTE_LINK = "crm-notes-2026-09.put-/crm/objects/2026-09/{fromObjectType}/{fromObjectId}/associations/default/{toObjectType}/{toObjectId}_/crm/objects/2026-09-beta/{fromObjectType}/{fromObjectId}/associations/default/{toObjectType}/{toObjectId}";
const DEAL_PATCH = "crm-deals-2026-09.patch-/crm/objects/2026-09/0-3/{dealId}_/crm/objects/2026-09-beta/{objectType}/{objectId}";
/** Standard pipeline stages that mean the deal is no longer open. A custom pipeline needs its own list (see SKILL.md). */
const CLOSED = ["closedwon", "closedlost"];

export const hubspot = {
  /** Open deals whose close date falls in the window, soonest first. */
  async openDeals(ctx: Ctx<Settings>): Promise<Deal[]> {
    const now = ctx.now.getTime();
    const r = await ctx.draft<any>({ platform: P, op: DEALS, summary: "read open deals closing in the window", input: { body: {
      filterGroups: [{ filters: [
        { propertyName: "closedate", operator: "BETWEEN", value: String(now), highValue: String(now + ctx.settings.window_days * DAY) },
        { propertyName: "dealstage", operator: "NOT_IN", values: CLOSED },
      ] }],
      properties: ["dealname", "dealstage", "closedate", "amount"],
      sorts: ["closedate"], limit: 50,
    } } });
    return (Array.isArray(r.data?.results) ? r.data.results : [])
      .filter((d: any) => ID.test(String(d?.id ?? "")))
      .map((d: any): Deal => ({
        id: String(d.id), name: clip(d.properties?.dealname, 200) || "Untitled deal", stage: clip(d.properties?.dealstage, 80),
        closedate: String(d.properties?.closedate ?? ""), amount: clip(d.properties?.amount, 40) || undefined,
      }));
  },

  /** Ids of the contacts or companies on a deal, first five. */
  async associated(ctx: Ctx<Settings>, dealId: string, to: "contacts" | "companies"): Promise<string[]> {
    if (!ID.test(dealId)) throw new Error("precall-research: deal id must be digits");
    const r = await ctx.draft<any>({ platform: P, op: DEAL_ASSOC, summary: `read ${to} on deal ${dealId}`,
      input: { params: { dealId, toObjectType: to, limit: 5 } } });
    return (Array.isArray(r.data?.results) ? r.data.results : [])
      .map((x: any) => String(x?.toObjectId ?? ""))
      .filter((x: string) => ID.test(x))
      .slice(0, 5);
  },

  /** A contact's name and title, plus its email when it is a valid address (used only to match Apollo, never written to a note). */
  async contact(ctx: Ctx<Settings>, id: string): Promise<{ person: Person; email?: string }> {
    if (!ID.test(id)) throw new Error("precall-research: contact id must be digits");
    const r = await ctx.draft<any>({ platform: P, op: CONTACT, summary: `read contact ${id}`,
      input: { params: { contactId: id, properties: ["firstname", "lastname", "jobtitle", "email"] } } });
    const p = r.data?.properties ?? {};
    const name = clip(`${p.firstname ?? ""} ${p.lastname ?? ""}`, 120);
    const email = typeof p.email === "string" && p.email.length <= 254 && EMAIL.test(p.email) ? p.email : undefined;
    return { person: { name: name || undefined, title: clip(p.jobtitle, 120) || undefined }, email };
  },

  async company(ctx: Ctx<Settings>, id: string): Promise<Company> {
    if (!ID.test(id)) throw new Error("precall-research: company id must be digits");
    const r = await ctx.draft<any>({ platform: P, op: COMPANY, summary: `read company ${id}`,
      input: { params: { companyId: id, properties: ["name", "domain", "industry", "numberofemployees", "description"] } } });
    const p = r.data?.properties ?? {};
    return {
      id, name: clip(p.name, 200) || undefined, domain: domainOf(p.domain), industry: clip(p.industry, 120) || undefined,
      employees: clip(p.numberofemployees, 20) || undefined, description: clip(p.description, 400) || undefined,
    };
  },

  /** Create the brief as an internal note. Returns the note id; the caller stores it before linking. */
  async createNote(ctx: Ctx<Settings>, dealId: string, html: string): Promise<string> {
    const r = await ctx.draft<any>({ platform: P, op: NOTE, summary: `pre-call brief note for deal ${dealId}`,
      input: { body: { properties: { hs_timestamp: ctx.now.toISOString(), hs_note_body: html } } } });
    const noteId = String(r.data?.id ?? "");
    if (!ID.test(noteId)) throw new Error("precall-research: HubSpot did not return a note id");
    return noteId;
  },

  /** Attach a note to its deal so it shows on the deal record. */
  async linkNote(ctx: Ctx<Settings>, noteId: string, dealId: string): Promise<void> {
    if (!ID.test(noteId) || !ID.test(dealId)) throw new Error("precall-research: note and deal ids must be digits");
    await ctx.draft({ platform: P, op: NOTE_LINK, summary: `link note ${noteId} to deal ${dealId}`,
      input: { params: { fromObjectType: "notes", fromObjectId: noteId, toObjectType: "0-3", toObjectId: dealId } } });
  },

  /** Queue the deal's next step for a person to approve. Nothing changes in HubSpot until that approval runs. */
  async queueNextStep(ctx: Ctx<Settings>, dealId: string, closeDay: string, text: string): Promise<string> {
    if (!ID.test(dealId)) throw new Error("precall-research: deal id must be digits");
    const summary = `Set the next step on deal ${dealId}: ${clip(text, 200)}`;
    return ctx.queue({ platform: P, op: DEAL_PATCH, key: `next:${dealId}:${closeDay}`, summary,
      input: { params: { dealId }, body: { properties: { hs_next_step: clip(text, 500) } } } }, summary);
  },
};
