// ActiveCampaign: the referring partner as a contact. Fields come from ActiveCampaign's official docs:
// POST /contact/sync takes {contact: {email, tags}} and creates or updates the contact by email;
// POST /contacts/{id}/tags takes {tags: [names]}; GET /contacts returns {contacts: [...]} and filters by email.
// Tags are what the business's own automation listens for, so both writes are only ever queued for approval.
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

/** The partner's contact id in ActiveCampaign, or undefined when the partner is not there yet. Reads only. */
export async function contactId(ctx: Ctx<Settings>, email: string): Promise<string | undefined> {
  const r = await ctx.draft<any>({ platform: "activecampaign", op: "docs.get_contacts", summary: "find partner contact",
    input: { params: { email } } });
  const list = Array.isArray(r.data?.contacts) ? r.data.contacts : [];
  const hit = list.find((c: any) => String(c.email ?? "").toLowerCase() === email.toLowerCase());
  return hit && /^\d{1,12}$/.test(String(hit.id)) ? String(hit.id) : undefined;
}

/** Create or update the partner by email, and apply a tag. Queued, never run by a cron. */
export const syncAct = (email: string, tag: string, key: string): Act => ({
  platform: "activecampaign", op: "docs.post_contact_sync", key, summary: `sync partner ${email} with tag ${tag}`,
  input: { body: { contact: { email, tags: [tag] } } },
});

/** Apply a tag to a partner who already has a contact. Queued, never run by a cron. */
export const tagAct = (contact: string, tag: string, key: string): Act => {
  if (!/^\d{1,12}$/.test(contact)) throw new Error("activecampaign: contact id must be digits");
  return { platform: "activecampaign", op: "docs.post_contacts_contactId_tags", key, summary: `tag partner contact ${contact} with ${tag}`,
    input: { params: { contactId: contact }, body: { tags: [tag] } } };
};
