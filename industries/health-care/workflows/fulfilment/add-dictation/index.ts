// The add-dictation workflow's three crons. Each reads, drafts or queues. None of them locks a note: the lock is a live
// operation that waits for a person's approval. Judgment (capturing the dictation, splitting it into the template's
// sections, marking a draft reviewed) belongs to the agent skill in SKILL.md, which writes the session into the store.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { createDraftNote, stillDraft, finaliseAct } from "./adapters/cliniko.ts";
import type { Session, Settings } from "./types.ts";

/** Every 15 minutes: each session whose note is ready is written to Cliniko as a draft treatment note. */
export async function draft(ctx: Ctx<Settings>) {
  let drafted = 0, flagged = 0;
  for (const s of Object.values(await ctx.store.list<Session>("sessions"))) {
    // A run that stopped after the write began never records the outcome. Nothing is created again without a person's check.
    if (s.status === "drafting") {
      await ctx.store.put("sessions", s.id, { ...s, status: "needs-check", reason: "draft started but not recorded: check Cliniko for this session before retrying" });
      flagged++;
      continue;
    }
    if (s.status !== "transcript-ready") continue;
    await ctx.store.put("sessions", s.id, { ...s, status: "drafting" });
    try {
      const note_id = await createDraftNote(ctx, s);
      await ctx.store.put("sessions", s.id, { ...s, status: "drafted", note_id, reason: undefined });
      drafted++;
    } catch {
      // The reason is generic on purpose: platform error text can carry patient detail.
      await ctx.store.put("sessions", s.id, { ...s, status: "needs-check", reason: "draft not created: the input was refused or the platform errored; check Cliniko before retrying" });
      flagged++;
    }
  }
  ctx.log(`draft: ${drafted} drafted, ${flagged} need a check`);
  return { drafted, needs_check: flagged };
}

/** Hourly: read drafted notes back (a clinician may have locked one in Cliniko), and follow each queued lock to its outcome. Reads only. */
export async function check(ctx: Ctx<Settings>) {
  let signed = 0, flagged = 0;
  for (const s of Object.values(await ctx.store.list<Session>("sessions"))) {
    if (s.status === "drafted" && s.note_id) {
      if ((await stillDraft(ctx, s)) === false) {
        await ctx.store.put("sessions", s.id, { ...s, status: "signed", reason: "locked in Cliniko" });
        signed++;
      }
    } else if (s.status === "sign-queued") {
      const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `sign:${s.id}`));
      if (ap?.status === "done") {
        await ctx.store.put("sessions", s.id, { ...s, status: "signed", reason: undefined });
        signed++;
      } else if (ap && ["failed", "rejected", "needs-check"].includes(ap.status)) {
        await ctx.store.put("sessions", s.id, { ...s, status: "needs-check", reason: `the lock was ${ap.status}: a person decides what happens next` });
        flagged++;
      }
    }
  }
  ctx.log(`check: ${signed} signed, ${flagged} need a check`);
  return { signed, needs_check: flagged };
}

/** Every 15 minutes: a session a clinician has marked reviewed is queued for its lock. The lock runs only when a person approves it. */
export async function sign(ctx: Ctx<Settings>) {
  let queued = 0;
  for (const s of Object.values(await ctx.store.list<Session>("sessions"))) {
    if (s.status !== "reviewed" || !s.note_id) continue;
    // The queue returns the existing approval when one is already waiting, so a second run never queues the lock twice.
    await ctx.queue(finaliseAct(s), `Lock the treatment note for session ${s.id} in Cliniko (locks it)`);
    await ctx.store.put("sessions", s.id, { ...s, status: "sign-queued", reason: undefined });
    queued++;
  }
  ctx.log(`sign: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { draft, check, sign };
