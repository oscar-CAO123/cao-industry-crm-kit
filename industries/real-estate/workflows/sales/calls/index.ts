import { queueCallNotes } from "./adapters/rex.ts";
// The calls workflow's three crons. Each reads, drafts or queues; none sends. A first-call or chaser email is an Outlook
// draft plus an approval, and a person approves it in the CRM shell. Which contacts to call, and the appraisal prep,
// are judgment steps in SKILL.md.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import * as agentbox from "../pipeline/adapters/agentbox.ts";
import * as rex from "../pipeline/adapters/rex.ts";
import { text } from "../pipeline/adapters/agentbox.ts";
import type { VendorContact } from "../pipeline/types.ts";
import { emailDraft } from "./adapters/microsoft-365.ts";
import { type CallLead, type Settings, EMAIL } from "./types.ts";

const DAY = 864e5;
const listContacts = (ctx: Ctx<Settings>) => {
  const p = ctx.settings.platform ?? "agentbox";
  if (p !== "agentbox" && p !== "rex") throw new Error("calls: platform must be agentbox or rex");
  return (p === "rex" ? rex : agentbox).listContacts(ctx as any);
};
const FIRST_CALL_SUBJECT = "A quick call about your property";
const CHASER_SUBJECT = "Following up on my last email";
const CHASER_TEXT = "Hi {name}, just following up on my last email in case it got buried. Happy to find a time that suits you.";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const nameOf = (c: VendorContact) => [text(c.forename, 60), text(c.surname, 60)].filter(Boolean).join(" ") || c.id;
const emailOf = (c: VendorContact) => { const e = text(c.email, 190); return EMAIL.test(e) ? e : undefined; };
const firstOf = (name: string) => name.split(" ")[0] || "there";
/** The approval key of a lead's first-call send. Attempt 0 keeps the plain key; each send after a rejection gets its own. */
const sendKey = (id: string, attempt = 0) => (attempt ? `send:${id}:${attempt}` : `send:${id}`);

/** The email body as escaped HTML. The name goes in by a function, so a "$" in a name is not read as a replacement pattern. */
function bodyHtml(template: string, first: string, business?: string): string {
  const greeting = (template || "Hi {name}, thanks for getting in touch.").replace("{name}", () => first);
  return `<p>${esc(greeting)}</p><p>Kind regards,<br>${esc(business ?? "")}</p>`;
}

/** Hourly: add each contact on the first page that the call list has not seen as "new". Refresh name and email when they change. Status is never set here. */
export async function callSync(ctx: Ctx<Settings>) {
  const now = ctx.now.toISOString();
  const contacts = await listContacts(ctx);
  let added = 0, updated = 0;
  for (const c of contacts) {
    const name = nameOf(c), email = emailOf(c);
    const prior = await ctx.store.get<CallLead>("call-leads", c.id);
    if (!prior) {
      await ctx.store.put("call-leads", c.id, { id: c.id, name, email, modified: text(c.modified, 40) || undefined, first_seen: now, status: "new" } satisfies CallLead);
      added++;
    } else if (prior.name !== name || prior.email !== email) {
      await ctx.store.put("call-leads", c.id, { ...prior, name, email, modified: text(c.modified, 40) || undefined });
      updated++;
    }
  }
  ctx.log(`call-sync: ${contacts.length} seen, ${added} added, ${updated} updated`);
  return { seen: contacts.length, added, updated };
}

/** Every 30 minutes: for each contact the agent marked to-contact, draft the first-call email in Outlook and queue its send. */
export async function callDraft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<CallLead>("call-leads")).filter((l) => l.status === "to-contact");
  let queued = 0, no_email = 0;
  for (const l of todo) {
    if (!l.email) { await ctx.store.put("call-leads", l.id, { ...l, status: "no-email" }); no_email++; continue; }
    // A first-call send that was rejected is queued again under a new key: the rejected approval would otherwise be returned as is.
    let attempt = l.attempt ?? 0;
    const prior = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, sendKey(l.id, attempt)));
    if (prior?.status === "rejected") attempt++;
    const html = bodyHtml(ctx.settings.first_call_text ?? "", firstOf(l.name), ctx.settings.business_name);
    const d = await emailDraft(ctx, l.email, FIRST_CALL_SUBJECT, html, sendKey(l.id, attempt));
    await ctx.queue(d.act, `First-call email to ${l.name} (${l.email})`);
    await ctx.store.put("call-leads", l.id, { ...l, status: "queued", message: d.messageId, queued_at: ctx.now.toISOString(), attempt });
    queued++;
  }
  ctx.log(`call-draft: ${queued} queued for approval, ${no_email} without an email`);
  return { queued, no_email };
}

/** Daily: mark first calls whose send was approved as sent, then queue each chaser that is due. */
export async function followUp(ctx: Ctx<Settings>) {
  const days = ctx.settings.follow_up?.after_days ?? [3, 7];
  let sent = 0;
  for (const l of Object.values(await ctx.store.list<CallLead>("call-leads"))) {
    if (l.status !== "queued") continue;
    const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, sendKey(l.id, l.attempt ?? 0)));
    if (ap?.status === "done") {
      await ctx.store.put("call-leads", l.id, { ...l, status: "sent", sent_at: ap.decided ?? ap.started ?? ctx.now.toISOString() });
      sent++;
    }
  }
  let queued = 0;
  for (const l of Object.values(await ctx.store.list<CallLead>("call-leads"))) {
    if (l.status !== "sent" || !l.sent_at || !l.email) continue;
    const n = l.followups?.length ?? 0;
    if (n >= days.length || ctx.now.getTime() - Date.parse(l.sent_at) < days[n] * DAY) continue;
    const d = await emailDraft(ctx, l.email, CHASER_SUBJECT, bodyHtml(CHASER_TEXT, firstOf(l.name), ctx.settings.business_name), `chaser${n + 1}:${l.id}`);
    await ctx.queue(d.act, `Chaser ${n + 1} to ${l.name} (${l.email})`);
    await ctx.store.put("call-leads", l.id, { ...l, followups: [...(l.followups ?? []), ctx.now.toISOString()] });
    queued++;
  }
  ctx.log(`follow-up: ${sent} first calls marked sent, ${queued} chasers queued`);
  return { sent, queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { callSync, callDraft, followUp, callNotes: queueCallNotes };
