// The patient support desk's three crons. Each reads, drafts and queues. None sends: a reply reaches a patient only
// after a person approves it in the CRM shell. Clinical questions never get an automatic reply. Judgment (what a
// booking change means, whether a patient needs a call back) stays with staff, as SKILL.md says.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import type { Contact, Enquiry, Settings } from "./types.ts";
import { cap, clinicalHits, keyOf } from "./types.ts";
import * as zendesk from "./adapters/zendesk.ts";
import { findPatient } from "./adapters/cliniko.ts";

const DAY = 864e5;

/** First name only, letters and hyphens or apostrophes; "there" when the name is missing or odd. Same rule as add-reminders. */
const firstName = (e: Enquiry) => {
  const first = cap(e.contact.name, 120).split(" ")[0] ?? "";
  return /^[A-Za-z][A-Za-z'-]{0,39}$/.test(first) ? first : "there";
};
const errorText = (err: unknown) => (err instanceof Error ? err.message : "unknown error").slice(0, 120);
/** The enquiry text is screened once, in draft, and not kept after that: the record keeps the ticket, contact and status. */
function unscreened(e: Enquiry): Enquiry {
  const { title: _title, text: _text, ...kept } = e;
  return kept;
}

function replyText(s: Settings, e: Enquiry): string {
  return [
    `Hi ${firstName(e)},`,
    "",
    `Thanks for getting in touch with ${s.business_name}. We have your message, and a member of our team will reply by ${s.turnaround ?? "the next business day"}.`,
    "",
    "If you are an existing patient, please reply with your full name so we can find your file.",
    "",
    s.signature ?? s.business_name,
  ].join("\n");
}

function chaserText(s: Settings, e: Enquiry): string {
  return [
    `Hi ${firstName(e)},`,
    "",
    "Just checking you received our reply about your enquiry. If you still need help, reply to this message and we will pick it up.",
    "",
    s.signature ?? s.business_name,
  ].join("\n");
}

/** Every 10 minutes: new help desk tickets, with the requester's name and email. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const t of await zendesk.newTickets(ctx)) {
    const id = `zendesk:${t.id}`;
    if (await ctx.store.get("enquiries", id)) continue;
    let contact: Contact = {};
    if (t.requester_id) {
      try { contact = await zendesk.requester(ctx, t.requester_id); }
      catch (err) { ctx.log(`intake: requester of ticket ${t.id} could not be read (${errorText(err)}), stored without contact`); }
    }
    await ctx.store.put("enquiries", id, { id, ticket: t.id, title: cap(t.subject, 200), text: cap(t.description, 4000), contact,
      received: t.created_at ?? ctx.now.toISOString(), status: "new" } satisfies Enquiry);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: match each new enquiry to a patient record, then queue one holding reply for approval.
 *  A clinical enquiry is escalated instead and gets no reply queued. Never sends. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => e.status === "new");
  let queued = 0, escalated = 0;
  for (const e of todo) {
    const hits = clinicalHits(ctx.settings, `${e.title} ${e.text}`);
    if (hits.length) {
      await ctx.store.put("enquiries", e.id, { ...unscreened(e), status: "clinician", reason: `clinical words (${hits.slice(0, 5).join(", ")}): a clinician answers, no automatic reply` } satisfies Enquiry);
      escalated++;
      continue;
    }
    const patient = ctx.settings.records === "cliniko" ? await findPatient(ctx, e.contact) : undefined;
    const body = replyText(ctx.settings, e);
    const key = keyOf(`reply-${e.ticket}`);
    const who = cap(e.contact.name, 120).replace(/[<>&"`]/g, "") || "the enquirer";
    const summary = `Reply to ticket ${e.ticket} from ${who} (${patient ? `patient record found by ${patient.matched_by}` : "no single patient record match"}): ${body.slice(0, 160)}`;
    await ctx.queue(zendesk.replyAct(e.ticket, body, key, summary));
    await ctx.store.put("enquiries", e.id, { ...unscreened(e), status: "queued", reply_key: key, ...(patient ? { patient } : {}) } satisfies Enquiry);
    queued++;
  }
  ctx.log(`draft: ${queued} queued, ${escalated} escalated`);
  return { queued, escalated };
}

/** Daily: note which replies were approved, check each ticket, and queue a chaser on replies still waiting for the
 *  enquirer. A ticket the enquirer has written back to goes to staff. Never sends. */
export async function followUp(ctx: Ctx<Settings>) {
  const days = ctx.settings.reply_after_days ?? [2, 5];
  let queued = 0;
  for (const found of Object.values(await ctx.store.list<Enquiry>("enquiries"))) {
    let e = found;
    if (e.status === "queued" && e.reply_key) {
      const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, e.reply_key));
      if (ap?.status !== "done") continue;
      e = { ...e, status: "replied", replied_at: ap.decided ?? ctx.now.toISOString() };
      await ctx.store.put("enquiries", e.id, e);
    }
    if (e.status !== "replied" || !e.replied_at) continue;
    let t: Awaited<ReturnType<typeof zendesk.ticket>>;
    try { t = await zendesk.ticket(ctx, e.ticket); }
    catch (err) {
      // A deleted or unreadable ticket goes to staff; the loop carries on to the next enquiry.
      ctx.log(`follow-up: ticket ${e.ticket} could not be read (${errorText(err)}), flagged for staff`);
      await ctx.store.put("enquiries", e.id, { ...e, status: "needs-staff", reason: "the ticket could not be read (deleted or unavailable)" } satisfies Enquiry);
      continue;
    }
    if (!t) continue;
    if (t.status === "solved" || t.status === "closed") { await ctx.store.put("enquiries", e.id, { ...e, status: "closed" } satisfies Enquiry); continue; }
    if (t.status === "open") { await ctx.store.put("enquiries", e.id, { ...e, status: "needs-staff", reason: "the enquirer wrote back" } satisfies Enquiry); continue; }
    if (t.status !== "pending") continue;
    const n = e.followups?.length ?? 0;
    if (n >= days.length || ctx.now.getTime() - Date.parse(e.replied_at) < days[n] * DAY) continue;
    await ctx.queue(zendesk.replyAct(e.ticket, chaserText(ctx.settings, e), keyOf(`chase-${n + 1}-${e.ticket}`),
      `Chaser ${n + 1} on ticket ${e.ticket}, ${days[n]} days after the reply`));
    e = { ...e, followups: [...(e.followups ?? []), ctx.now.toISOString()] };
    await ctx.store.put("enquiries", e.id, e);
    queued++;
  }
  ctx.log(`follow-up: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, "follow-up": followUp };
