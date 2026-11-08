// Smokeball: sender lookup, open matters, lead matters, notes, follow-up tasks and portal replies.
// Field names come from docs.smokeball.com/openapi.json (the vendor spec in endpoint-map/raw/smokeball).
// A portal reply is the only message to a client, so it is a live act: the cron queues it and a person approves it.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Email, Settings } from "../types.ts";

const P = "smokeball";
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/** Smokeball ids are GUIDs. Anything else is refused before it reaches a path or a body. */
export const platformId = (v: unknown, what: string): string => {
  const s = String(v ?? "");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) throw new Error(`x-matter: bad ${what}`);
  return s;
};
/** The spec types list responses loosely: accept a bare array or a value collection. */
const rows = (d: any): any[] => (Array.isArray(d) ? d : Array.isArray(d?.value) ? d.value : []);
/** Plain text for a note or message: control characters removed, length capped. Smokeball notes take plain text or RTF. */
const plain = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n);
/** The id a create returns: from the body, or the record header when the body has none. */
const createdId = (r: { data?: any; headers?: Headers }, what: string) =>
  platformId(r.data?.id ?? r.headers?.get?.("x-record-uuid"), what);

/** Contacts whose address matches the sender. Zero, one, or several: the caller decides. */
export async function contactIds(ctx: Ctx<Settings>, from: string): Promise<string[]> {
  if (!EMAIL.test(from)) throw new Error("x-matter: bad sender address");
  const r = await ctx.draft<any>({ platform: P, op: "GetContacts", summary: "find the sender as a contact", input: { params: { Search: from, Limit: 5 } } });
  return rows(r.data).map((c) => platformId(c.id, "contact"));
}

/** Matters this contact is on that are not closed (a lead counts). */
export async function openMatters(ctx: Ctx<Settings>, contactId: string): Promise<string[]> {
  const r = await ctx.draft<any>({ platform: P, op: "GetMatters", summary: "open matters for the sender",
    input: { params: { ContactId: platformId(contactId, "contact"), Limit: 20 } } });
  return rows(r.data).filter((m) => !m.closedDate).map((m) => platformId(m.id, "matter"));
}

/** Open a lead matter for a sender nobody has matched. The lead is internal until a person opens it. */
export async function createLead(ctx: Ctx<Settings>, e: Email, matterTypeId: string, contactId?: string): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "CreateMatter", summary: `lead matter for ${e.from}`,
    input: { body: { matterTypeId: platformId(matterTypeId, "matter type"), isLead: true, leadOpenedDate: ctx.now.toISOString(),
      description: plain(`Lead: ${e.subject}`, 200),
      ...(contactId ? { clientIds: [platformId(contactId, "contact")] } : {}) } } });
  return createdId(r, "matter");
}

/** The notes already on a matter, newest first, read so a reply can use the history. */
export async function recentNotes(ctx: Ctx<Settings>, matterId: string): Promise<{ title: string; created: string | null; plain: string }[]> {
  const r = await ctx.draft<any>({ platform: P, op: "GetMemos", summary: "recent notes on the matter",
    input: { params: { matterId: platformId(matterId, "matter"), Limit: 10 } } });
  return rows(r.data).slice(0, 10).map((m) => ({ title: plain(m.title, 200), created: m.createdDate ?? null, plain: plain(m.plainText, 400) }));
}

/** A note of the email on the matter. Plain text: the subject, the sender, the time received and a short excerpt. */
export async function createNote(ctx: Ctx<Settings>, e: Email, matterId: string): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "CreateMemo", summary: `note of ${e.subject} on the matter`,
    input: { params: { matterId: platformId(matterId, "matter") }, body: {
      title: plain(`Email: ${e.subject}`, 200),
      text: plain(`From ${e.name ? `${e.name} ` : ""}<${e.from}>, received ${e.received}.\n\n${e.text ?? ""}`, 4000),
      createdDateUtc: ctx.now.toISOString() } } });
  return createdId(r, "note");
}

/** A follow-up task on the matter: the reply is due in reply_due_days. */
export async function createTask(ctx: Ctx<Settings>, e: Email, matterId: string): Promise<string> {
  const days = Math.min(30, Math.max(1, Math.trunc(ctx.settings.reply_due_days ?? 2)));
  const r = await ctx.draft<any>({ platform: P, op: "CreateTask", summary: `follow-up task for ${e.subject}`,
    input: { body: { matterId: platformId(matterId, "matter"), subject: plain(`Reply to ${e.from}: ${e.subject}`, 200),
      note: plain("Written by the email-to-matter workflow. Check the matter before replying.", 500),
      dueDate: new Date(ctx.now.getTime() + days * 864e5).toISOString() } } });
  return createdId(r, "task");
}

/** The live act for a reply: a portal message to the client's contact on the matter. A person approves it before it runs. */
export function portalAct(ctx: Ctx<Settings>, e: Email): Act {
  if (!e.matter_id || !e.contact_id || !e.reply) throw new Error("x-matter: a reply needs a matter, a contact and text");
  return { platform: P, op: "SendPortalMessageAsync", key: `reply:${e.id}`, summary: `portal reply to ${e.from} on ${e.subject}`,
    input: { params: { matterId: platformId(e.matter_id, "matter") }, body: { contactId: platformId(e.contact_id, "contact"), message: plain(e.reply, 5000) } } };
}
