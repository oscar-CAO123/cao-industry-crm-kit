// GoHighLevel: voice-AI call logs (read), a contact note (an internal record, drafted) and a rep email (queued only).
// Field names from the GoHighLevel spec: voice-AI CallLogDTO (id, contactId, createdAt, duration, summary, transcript),
// the contact notes body (NotesDTO: body, title) and the conversation send body (SendMessageBodyDto: type, contactId,
// subject, html, emailFrom).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type CallRecord, type Settings, ID, TRANSCRIPT_CAP, clip, keyOf } from "../types.ts";

const P = "gohighlevel" as const;

/** Call logs with a transcript since the watermark (default: the last seven days). */
export async function recent(ctx: Ctx<Settings>, since: string | undefined, max: number): Promise<CallRecord[]> {
  const loc = ctx.settings.locationId;
  if (!loc || !ID.test(loc)) { ctx.log("gohighlevel: no locationId in settings, nothing read"); return []; }
  const startDate = since ? Date.parse(since) : ctx.now.getTime() - 7 * 864e5;
  const r = await ctx.draft<any>({ platform: P, op: "voice-ai.get-call-logs", summary: "list recent call logs",
    input: { params: { locationId: loc, startDate, pageSize: max } } });
  const out: CallRecord[] = [];
  for (const c of (Array.isArray(r.data?.callLogs) ? r.data.callLogs : []).slice(0, max)) {
    const id = String(c?.id ?? "");
    if (!ID.test(id) || !c.transcript) continue;   // only a call with a transcript can be scored
    const key = keyOf(`${P}:${id}`);
    if (await ctx.store.get("calls", key)) continue;
    const when = clip(c.createdAt ?? ctx.now.toISOString(), 40);
    out.push({
      key, platform: P, ref: id, title: `Voice call ${when.slice(0, 10)}`, happened: when,
      contactId: ID.test(String(c.contactId ?? "")) ? String(c.contactId) : undefined,
      duration_min: Number(c.duration) > 0 ? Math.round(Number(c.duration) / 60) : undefined,
      summary: clip(c.summary, 2000), next_steps: [],
      transcript: clip(c.transcript, TRANSCRIPT_CAP), captured: ctx.now.toISOString(),
    });
  }
  return out;
}

/** An internal note on the call's contact. Returns false when the call has no safe contact to note. */
export async function note(ctx: Ctx<Settings>, call: { key: string; ref: string; contactId?: string }, text: string): Promise<boolean> {
  if (!call.contactId || !ID.test(call.contactId)) return false;
  await ctx.draft({ platform: P, op: "contacts.create-note", summary: `coaching note for call ${call.ref}`,
    input: { params: { contactId: call.contactId }, body: { body: clip(text, 5000), title: "Call coaching" } } });
  return true;
}

/** A coaching email to a rep, queued for approval. It is never sent here. */
export function queueRepEmail(ctx: Ctx<Settings>, call: { key: string }, repContactId: string, subject: string, html: string, summary: string): Promise<string> {
  if (!ID.test(repContactId)) throw new Error("gohighlevel: rep contact id is not valid");
  return ctx.queue({ platform: P, op: "conversations.send-a-new-message", key: `coach:${call.key}`, summary,
    input: { body: { type: "Email", contactId: repContactId, subject: clip(String(subject ?? "").replace(/[\r\n]+/g, " "), 200), html: clip(html, 20000),
                     ...(ctx.settings.coach_from ? { emailFrom: ctx.settings.coach_from } : {}) } } });
}
