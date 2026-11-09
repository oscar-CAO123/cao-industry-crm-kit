// GoHighLevel: where the caller's contact and the internal note about the missed call live. Both are draft operations:
// they reach nobody outside the business. No text is sent through GoHighLevel in this workflow.
// Field names come from the vendor's official spec (endpoint-map/raw/gohighlevel/spec): contacts/upsert takes locationId
// and phone; contacts/{contactId}/notes takes body.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, clean, id, masked } from "../types.ts";

const P = "gohighlevel";

export const gohighlevel = {
  /** The contact for a caller's number: found or created in the configured location. Returns the contact id. */
  async contactFor(ctx: Ctx<Settings>, phone: string): Promise<string> {
    const r = await ctx.draft<any>({ platform: P, op: "contacts.upsert-contact", summary: `contact for ${masked(phone)}`,
      input: { body: { locationId: id(ctx.settings.gohighlevel?.location_id, "location id"), phone } } });
    return id(r.data?.contact?.id, "contact id");
  },

  /** One internal note on a contact. It reaches nobody outside the business. */
  async note(ctx: Ctx<Settings>, contactId: string, text: string): Promise<void> {
    await ctx.draft({ platform: P, op: "contacts.create-note", summary: "missed call note",
      input: { params: { contactId: id(contactId, "contact id") }, body: { body: clean(text, 500) } } });
  },
};
