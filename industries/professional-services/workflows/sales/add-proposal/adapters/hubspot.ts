// HubSpot quotes: the proposal lives as a quote. Create and read run as drafts; publishing is a live status change.
// Field names are read from settings (see gaps in workflow.json); the request shapes follow the vendor spec for crm-quotes-3.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { HS_ID, type Proposal, type Settings } from "../types.ts";

export const P = "hubspot";
const hsId = (v: unknown) => { const s = String(v ?? ""); if (!HS_ID.test(s)) throw new Error("hubspot: bad id"); return s; };

/** Create a draft quote on the proposal's contact. Returns the new quote id. */
export async function createDraftQuote(ctx: Ctx<Settings>, p: Proposal): Promise<string> {
  const h = ctx.settings.hubspot, assoc = h.contact_association;
  if (typeof assoc.associationTypeId !== "number") throw new Error("hubspot: settings.hubspot.contact_association.associationTypeId is not set");
  const expires = new Date(ctx.now.getTime() + (ctx.settings.quote_valid_days ?? 30) * 864e5).toISOString().slice(0, 10);
  const r = await ctx.draft<{ id?: string }>({ platform: P, op: "crm-quotes-3.post-/crm/v3/objects/quotes_create", summary: `draft quote for ${p.title}`,
    input: { body: {
      properties: { [h.property.title]: p.title.slice(0, 200), [h.property.expiration]: expires, [h.property.amount]: String(p.fee_ex_gst) },
      associations: [{ to: { id: hsId(p.contact_id) }, types: [{ associationCategory: assoc.associationCategory, associationTypeId: assoc.associationTypeId }] }],
    } } });
  return hsId(r.data?.id);
}

/** The quote's status property, as HubSpot holds it right now. */
export async function readQuoteStatus(ctx: Ctx<Settings>, quoteId: string): Promise<string> {
  const prop = ctx.settings.hubspot.property.status;
  const r = await ctx.draft<{ properties?: Record<string, string> }>({ platform: P, op: "crm-quotes-3.get-/crm/v3/objects/quotes/{quoteId}_getById",
    summary: `read quote ${quoteId}`, input: { params: { quoteId: hsId(quoteId), properties: [prop] } } });
  return String(r.data?.properties?.[prop] ?? "");
}

/** The live act that publishes a drafted quote so the client can see it. Queued only; a person approves it. */
export function publishAct(ctx: Ctx<Settings>, p: Proposal, key: string): Act {
  return { platform: P, op: "crm-quotes-3.patch-/crm/v3/objects/quotes/{quoteId}_update", key,
    summary: `publish quote ${p.quote_id} for ${p.title}`,
    input: { params: { quoteId: hsId(p.quote_id) }, body: { properties: { [ctx.settings.hubspot.property.status]: ctx.settings.hubspot.status_values.published } } } };
}
