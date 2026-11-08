// GoHighLevel: the lapsed list is the contacts carrying the business's lapsed tag. A contact is enrolled in a campaign the business
// built in GoHighLevel, so the campaign's own steps, copy and do-not-disturb rules decide what is sent. Tags and tasks are internal.
// Field names: v3 GET /contacts/ (locationId, startAfterId, limit; reply contacts[] with id, email, tags), v3 POST
// /contacts/{contactId}/campaigns/{campaignId} (no body), v3 POST /contacts/{contactId}/tags (tags[]), v3 POST /contacts/{contactId}/tasks
// (title, body, dueDate, completed). From GoHighLevel's official OpenAPI files in the endpoint map.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, ID, EMAIL } from "../types.ts";

const P = "gohighlevel" as const;
const PAGE = 100;

export interface Person { id: string; email?: string }

/** Contacts with the lapsed tag and not yet the sent tag. Pages on startAfterId until a page comes back short. */
export async function lapsedContacts(ctx: Ctx<Settings>): Promise<Person[]> {
  const s = ctx.settings;
  const out = new Map<string, Person>();
  let after: string | undefined;
  for (let page = 0; page < (s.max_pages ?? 60); page++) {
    const r = await ctx.draft<any>({ platform: P, op: "contacts.get-contacts", summary: `read contacts page ${page + 1}`,
      input: { params: { locationId: s.location_id, limit: PAGE, ...(after ? { startAfterId: after } : {}) } } });
    const list: any[] = Array.isArray(r.data?.contacts) ? r.data.contacts : [];
    for (const c of list) {
      const id = String(c?.id ?? "");
      if (!ID.test(id)) continue;
      const tags: string[] = Array.isArray(c.tags) ? c.tags.map(String) : [];
      if (tags.includes(s.lapsed_tag) && !tags.includes(s.sent_tag)) {
        out.set(id, { id, email: EMAIL.test(String(c.email ?? "")) ? String(c.email) : undefined });
      }
    }
    const last = String(list.at(-1)?.id ?? "");
    if (list.length < PAGE || !ID.test(last)) break;
    after = last;
  }
  return [...out.values()];
}

/** One queued enrolment: the contact goes into the campaign when a person approves it. */
export function enrolAct(campaign: string, contactId: string, key?: string): Act {
  if (!ID.test(campaign) || !ID.test(contactId)) throw new Error("lead-reactivation: campaign and contact ids must be plain ids");
  return { platform: P, op: "contacts.add-contact-to-campaign", key, summary: `enrol ${contactId} in campaign ${campaign}`,
    input: { params: { contactId, campaignId: campaign } } };
}

export async function tagContact(ctx: Ctx<Settings>, contactId: string, tag: string): Promise<void> {
  if (!ID.test(contactId)) throw new Error("lead-reactivation: contact id must be a plain id");
  await ctx.draft({ platform: P, op: "contacts.add-tags", summary: `tag ${contactId} "${tag}"`,
    input: { params: { contactId }, body: { tags: [tag] } } });
}

export async function taskContact(ctx: Ctx<Settings>, contactId: string, title: string, body: string, due: string): Promise<void> {
  if (!ID.test(contactId)) throw new Error("lead-reactivation: contact id must be a plain id");
  await ctx.draft({ platform: P, op: "contacts.create-task", summary: `task for ${contactId}`,
    input: { params: { contactId }, body: { title: title.slice(0, 200), body: body.slice(0, 2000), dueDate: due, completed: false } } });
}
