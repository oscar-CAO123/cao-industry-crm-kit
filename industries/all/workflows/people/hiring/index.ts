// The hiring workflow's two crons. Each one reads, drafts and queues; neither sends. Judgment (reading a CV, shortlisting,
// choosing who to interview) belongs to the owner, who sets an applicant's decision; the crons act on that decision only.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { type Applicant, type Settings, type Stage, letterHtml } from "./types.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";

/** Every 10 minutes: new applications from the mailbox, each one a register row and a stored applicant. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const a of await microsoft365.applications(ctx)) {
    if (await ctx.store.get("applicants", a.id)) continue;
    const applicant: Applicant = { ...a, stage: "new" };
    await microsoft365.registerRow(ctx, applicant);
    await ctx.store.put("applicants", a.id, applicant);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: an applicant who is new gets an acknowledgement; one the owner has decided on gets the matching email.
 *  Each email is an Outlook draft plus a queued send, so a person presses send. One email per stage, never twice. */
export async function draft(ctx: Ctx<Settings>) {
  const people = Object.values(await ctx.store.list<Applicant>("applicants"));
  let queued = 0, no_address = 0;
  for (const a of people) {
    const kind = a.decision && (a.stage === "new" || a.stage === "acknowledged") ? (a.decision === "interview" ? "invite" : "decline")
      : a.stage === "new" ? "ack" : undefined;
    if (!kind) continue;
    if (!a.email) { no_address++; continue; }   // no address to reply to: a person follows it up
    const key = `${kind}:${a.id}`;
    const letter = letterHtml(ctx.settings, kind, a);
    const d = await microsoft365.replyDraft(ctx, a.email, letter.subject, letter.html);
    await ctx.queue({ ...d.act, key }, `${kind === "ack" ? "acknowledgement" : kind === "invite" ? "interview invitation" : "decline"} to ${a.email} for ${a.role}`);
    const next: Stage = kind === "ack" ? "acknowledged" : kind === "invite" ? "invited" : "declined";
    await ctx.store.put("applicants", a.id, { ...a, stage: next, ref: { ...a.ref, [kind + "_approval"]: approvalId(ctx.workflow.id, key) } } satisfies Applicant);
    queued++;
  }
  ctx.log(`draft: ${queued} queued, ${no_address} without an address`);
  return { queued, no_address };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft };
