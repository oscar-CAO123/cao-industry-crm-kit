// The contracts workflow's three crons. Each reads, drafts and queues; none sends. A person approves every email.
// Judgment (reading the contract, flagging clauses) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { type Contract, type Envelope, type Settings, EMAIL, daysSince, keyOf } from "./types.ts";
import * as m365 from "./adapters/microsoft-365.ts";
import * as ds from "./adapters/docusign.ts";

/** Every 15 minutes: contract emails from the folder, each logged once as new. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const c of await m365.newContracts(ctx)) {
    if (await ctx.store.get("contracts", c.id)) continue;
    await ctx.store.put("contracts", c.id, { ...c, status: "new" } satisfies Contract);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 30 minutes: a register row and a review note for each new contract. The note's send waits for approval. */
export async function review(ctx: Ctx<Settings>) {
  let drafted = 0;
  for (const found of Object.values(await ctx.store.list<Contract>("contracts"))) {
    if (found.status !== "new") continue;
    let c = found;
    // An approval already queued for this contract (a rejected one included) means the note was drafted before: never draft it twice.
    if (!(await ctx.store.get("approvals", approvalId(ctx.workflow.id, `review:${c.id}`)))) {
      // Each step is saved as soon as it succeeds, so a failure in a later step never repeats an earlier one on the next run.
      if (!c.ref.draft_message) {
        const draftId = await m365.reviewNoteDraft(ctx, c);
        c = { ...c, ref: { ...c.ref, draft_message: draftId } };
        await ctx.store.put("contracts", c.id, c satisfies Contract);
      }
      if (!c.ref.register_row) {
        await m365.registerRow(ctx, c);
        c = { ...c, ref: { ...c.ref, register_row: "done" } };
        await ctx.store.put("contracts", c.id, c satisfies Contract);
      }
      await ctx.queue(m365.reviewNoteAct(ctx, c, c.ref.draft_message));
      drafted++;
    }
    await ctx.store.put("contracts", c.id, { ...c, status: "in-review" } satisfies Contract);
  }
  ctx.log(`review: ${drafted} notes drafted and queued for approval`);
  return { drafted };
}

/** Daily: each unsigned signer on an envelope out for signature gets one reminder, queued for approval, on the set schedule. */
export async function followUp(ctx: Ctx<Settings>) {
  if (!ctx.settings.docusign) return { queued: 0, note: "docusign is not set for this client" };
  const days = ctx.settings.follow_up?.after_days ?? [3, 7, 14];
  let queued = 0;
  for (const e of await ds.envelopes(ctx)) {
    const id = keyOf(`docusign:${e.id}`);
    const prev = await ctx.store.get<Envelope>("envelopes", id);
    e.reminders = prev?.reminders ?? [];
    await ctx.store.put("envelopes", id, e);
    if (e.status !== "sent" && e.status !== "delivered") continue;
    if (!e.sent) continue;
    const n = e.reminders.length;
    if (n >= days.length) continue;
    // The first reminder is due days[0] after sending; each later one, the gap between the set days, after the last reminder.
    const last = e.reminders.at(-1) ?? e.sent;
    const gap = n === 0 ? days[0] : days[n] - days[n - 1];
    if (daysSince(last, ctx.now) < gap) continue;
    let touched = false;
    for (const s of e.signers) {
      if (!EMAIL.test(s.email) || s.status === "completed") continue;
      const key = `remind:${id}:${n + 1}:${s.email}`;
      touched = true;
      if (await ctx.store.get("approvals", approvalId(ctx.workflow.id, key))) continue;
      await ctx.queue(await m365.reminderDraft(ctx, s, e.subject, key));
      queued++;
    }
    if (touched) {
      e.reminders.push(ctx.now.toISOString());
      await ctx.store.put("envelopes", id, e);
    }
  }
  ctx.log(`follow-up: ${queued} reminders queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, review, "follow-up": followUp };
