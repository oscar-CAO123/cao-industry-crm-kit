// The email-to-matter workflow's three crons. Each reads, drafts or queues; none sends. A reply to a client is queued
// for a person to approve, and the approval is the only thing that runs it. Judgment (which matter, what to reply)
// belongs to the person in the CRM shell and the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Email, Settings } from "./types.ts";
import * as sm from "./adapters/smokeball.ts";

const emailsWith = async (ctx: Ctx<Settings>, status: Email["status"]) =>
  Object.values(await ctx.store.list<Email>("emails")).filter((e) => e.status === status);
const save = (ctx: Ctx<Settings>, e: Email) => ctx.store.put("emails", e.id, e);

/** Every 10 minutes: match each new email's sender to an open matter, or open a lead when the firm allows it. */
export async function intake(ctx: Ctx<Settings>) {
  let matched = 0, parked = 0;
  for (const e of await emailsWith(ctx, "new")) {
    if (!sm.EMAIL.test(e.from)) { parked++; await save(ctx, { ...e, status: "needs-person", reason: "the sender address is not valid" }); continue; }
    const contacts = await sm.contactIds(ctx, e.from);
    if (contacts.length > 1) { parked++; await save(ctx, { ...e, status: "needs-person", reason: "more than one contact has this address" }); continue; }
    const contactId = contacts[0];
    const matters = contactId ? await sm.openMatters(ctx, contactId) : [];
    if (matters.length > 1) { parked++; await save(ctx, { ...e, status: "needs-person", reason: "the sender is on more than one open matter", contact_id: contactId }); continue; }
    if (matters.length === 1) { matched++; await save(ctx, { ...e, status: "matched", contact_id: contactId, matter_id: matters[0], lead: false }); continue; }
    if (!ctx.settings.lead_matter_type_id) {
      parked++; await save(ctx, { ...e, status: "needs-person", reason: "no open matter for this sender, and no lead matter type is set", contact_id: contactId });
      continue;
    }
    // A crash between the create and this save can repeat the lead: check the matter list after such a crash.
    const leadId = await sm.createLead(ctx, e, ctx.settings.lead_matter_type_id, contactId);
    matched++;
    await save(ctx, { ...e, status: "matched", contact_id: contactId, matter_id: leadId, lead: true });
  }
  ctx.log(`intake: ${matched} matched, ${parked} need a person`);
  return { matched, needs_person: parked };
}

/** Every 15 minutes: read the matter's recent notes, then record a note of the email and a follow-up task on the matter. */
export async function file(ctx: Ctx<Settings>) {
  let filed = 0;
  for (const matched of await emailsWith(ctx, "matched")) {
    let e = matched;
    if (!e.matter_id) continue;
    if (!e.context) { e = { ...e, context: await sm.recentNotes(ctx, e.matter_id) }; await save(ctx, e); }   // read before filing, saved first
    if (!e.memo_id) { e = { ...e, memo_id: await sm.createNote(ctx, e, e.matter_id) }; await save(ctx, e); }  // saved at once: a re-run never files the note twice
    if (!e.task_id) { e = { ...e, task_id: await sm.createTask(ctx, e, e.matter_id) }; await save(ctx, e); }
    await save(ctx, { ...e, status: "filed" });
    filed++;
  }
  ctx.log(`file: ${filed} filed`);
  return { filed };
}

/** Every 30 minutes: queue each written reply as a portal message for a person to approve. Nothing is sent here. */
export async function reply(ctx: Ctx<Settings>) {
  let queued = 0, parked = 0;
  for (const e of await emailsWith(ctx, "filed")) {
    if (!e.reply || e.reply_approval) continue;
    if (!e.contact_id) { parked++; await save(ctx, { ...e, reason: "no contact on the matter to message: reply by hand" }); continue; }
    const id = await ctx.queue(sm.portalAct(ctx, e), `portal reply to ${e.from} on ${e.subject}`);
    await save(ctx, { ...e, reply_approval: id });
    queued++;
  }
  ctx.log(`reply: ${queued} queued, ${parked} need a person`);
  return { queued, needs_person: parked };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, file, reply };
