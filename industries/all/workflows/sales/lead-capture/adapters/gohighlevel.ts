// GoHighLevel: where web form and live chat leads already land. Every field name below is confirmed in the vendor's
// spec (endpoint-map/raw/gohighlevel/spec): submissions (submissions, id, contactId, createdAt, email), chats
// (conversations, id, contactId, unreadCount, fullName, email, phone), tags, opportunities (pipelineId, locationId,
// name, status, contactId, pipelineStageId, assignedTo), appointments (events, status) and messages (type, contactId,
// subject, html, message). Reads and internal records are draft operations; a message to a lead is only ever built
// here as an Act and queued by the cron for a person to approve.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ID, EMAIL, PHONE, clean, esc, fill, firstName, maskEmail, maskPhone, type RawLead, type Lead, type Settings } from "../types.ts";

export const P = "gohighlevel" as const;

function cfg(ctx: Ctx<Settings>) {
  const g = ctx.settings.gohighlevel;
  if (!g || !ID.test(g.location_id ?? "")) throw new Error("gohighlevel.location_id is not set");
  return g;
}
const idOf = (v: unknown): string | undefined => (typeof v === "string" && ID.test(v) ? v : undefined);
const emailOf = (v: any): string | undefined => (typeof v?.email === "string" && EMAIL.test(v.email) ? v.email : undefined);
const phoneOf = (v: any): string | undefined => (typeof v?.phone === "string" && PHONE.test(v.phone) ? v.phone : undefined);

/** Form submissions created after `since` (ms). Each one already has a contact in GoHighLevel. */
export async function readSubmissions(ctx: Ctx<Settings>, since: number): Promise<RawLead[]> {
  const g = cfg(ctx);
  const formId = g.form_id && ID.test(g.form_id) ? { formId: g.form_id } : {};
  const r = await ctx.draft<any>({ platform: P, op: "forms.get-forms-submissions", summary: "read form submissions",
    input: { params: { locationId: g.location_id, limit: 50, ...formId } } });
  const out: RawLead[] = [];
  for (const s of r.data?.submissions ?? []) {
    const ref = idOf(s?.id), contactId = idOf(s?.contactId), at = Date.parse(String(s?.createdAt ?? ""));
    if (!ref || !contactId || !(at > since)) continue;
    out.push({ source: "form", ref, contactId, name: clean(s?.name, 120), email: emailOf(s), received: new Date(at).toISOString() });
  }
  return out;
}

/** Live chats with a visitor message still unanswered, whose last message is after `since` (ms), the intake baseline.
 *  A chat with no readable last-message time is skipped, so an old chat never becomes a new lead. A chat with no contact details yet is checked again next run. */
export async function readChats(ctx: Ctx<Settings>, since: number): Promise<RawLead[]> {
  const g = cfg(ctx);
  const r = await ctx.draft<any>({ platform: P, op: "conversations.search-conversation", summary: "read live chats",
    input: { params: { locationId: g.location_id, limit: 50 } } });
  const out: RawLead[] = [];
  for (const c of r.data?.conversations ?? []) {
    const ref = idOf(c?.id), contactId = idOf(c?.contactId);
    if (!ref || !contactId || !(Number(c?.unreadCount) > 0)) continue;
    const at = Date.parse(String(c?.lastMessageDate ?? ""));
    if (!(at > since)) continue;
    out.push({ source: "live-chat", ref, contactId, name: clean(c?.fullName ?? c?.contactName, 120),
      email: emailOf(c), phone: phoneOf(c), received: new Date(at).toISOString() });
  }
  return out;
}

export async function tagContact(ctx: Ctx<Settings>, contactId: string, tags: string[]): Promise<void> {
  const list = tags.map((t) => clean(t, 60)).filter(Boolean).slice(0, 10);
  if (!list.length) return;
  await ctx.draft({ platform: P, op: "contacts.add-tags", summary: `tag lead with ${list.join(", ")}`,
    input: { params: { contactId }, body: { tags: list } } });
}

/** An open opportunity in the new-lead stage. Returns undefined when the pipeline is not set in settings. */
export async function openOpportunity(ctx: Ctx<Settings>, lead: Lead): Promise<string | undefined> {
  const g = cfg(ctx);
  if (!g.pipeline_id || !g.new_stage_id) return undefined;
  if (!ID.test(g.pipeline_id) || !ID.test(g.new_stage_id)) throw new Error("gohighlevel pipeline or stage id is malformed");
  const owner = g.owner_user_id && ID.test(g.owner_user_id) ? { assignedTo: g.owner_user_id } : {};
  const label = lead.source === "form" ? "web form" : "live chat";
  const r = await ctx.draft<any>({ platform: P, op: "opportunities.create-opportunity", summary: `open ${label} lead`,
    input: { body: { pipelineId: g.pipeline_id, locationId: g.location_id, name: clean(`${lead.name || "Web lead"} (${label})`, 120),
      status: "open", contactId: lead.contactId, pipelineStageId: g.new_stage_id, ...owner } } });
  return idOf(r.data?.opportunity?.id);
}

/** True when the lead already has a live appointment, or a message from them is still waiting for a reply. */
export async function engaged(ctx: Ctx<Settings>, contactId: string): Promise<boolean> {
  const g = cfg(ctx);
  const a = await ctx.draft<any>({ platform: P, op: "contacts.get-appointments-for-contact", summary: "check appointments",
    input: { params: { contactId } } });
  if ((a.data?.events ?? []).some((e: any) => !/^cancel+ed$/i.test(String(e?.status ?? "")))) return true;
  const c = await ctx.draft<any>({ platform: P, op: "conversations.search-conversation", summary: "check for an unanswered message",
    input: { params: { locationId: g.location_id, contactId } } });
  return (c.data?.conversations ?? []).some((x: any) => Number(x?.unreadCount) > 0);
}

/** A message to the lead, as an Act for approval. Undefined when the lead has no detail for that channel. */
export function messageAct(s: Settings, lead: Lead, channel: "Email" | "SMS", template: string, subject: string, key: string, kind: string): Act | undefined {
  const message = fill(template, { first: firstName(lead.name), business: clean(s.business_name ?? "us", 120) });
  if (channel === "Email") {
    if (!lead.email) return undefined;
    return { platform: P, op: "conversations.send-a-new-message", key, summary: `${kind} email to ${maskEmail(lead.email)}`,
      input: { body: { type: "Email", contactId: lead.contactId, subject: clean(subject, 150), html: `<p>${esc(message)}</p>` } } };
  }
  if (!lead.phone) return undefined;
  return { platform: P, op: "conversations.send-a-new-message", key, summary: `${kind} text to ${maskPhone(lead.phone)}`,
    input: { body: { type: "SMS", contactId: lead.contactId, message: message.slice(0, 480) } } };
}
