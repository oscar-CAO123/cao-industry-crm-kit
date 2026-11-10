// The results-and-letters workflow's two crons. Neither sends anything. draft writes the agent's GP letter to Cliniko as a
// draft note; recall queues a results-review recall, which runs only when a person approves it. Judgment (reading the
// result and writing the letter from the clinician's words) belongs to the agent skill in SKILL.md, which writes the
// result into the store with status letter-ready.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { createDraftNote, recallAct } from "./adapters/cliniko.ts";
import type { Result, Settings } from "./types.ts";

/** Every 15 minutes: each result whose GP letter is ready is written to Cliniko as a draft treatment note. */
export async function draft(ctx: Ctx<Settings>) {
  let drafted = 0, flagged = 0;
  for (const r of Object.values(await ctx.store.list<Result>("results"))) {
    // A run that stopped after the write began never records the outcome. Nothing is created again without a person's check.
    if (r.status === "drafting") {
      await ctx.store.put("results", r.id, { ...r, status: "needs-check", reason: "draft started but not recorded: check Cliniko for this letter before retrying" });
      flagged++;
      continue;
    }
    if (r.status !== "letter-ready" || !r.letter) continue;
    await ctx.store.put("results", r.id, { ...r, status: "drafting" });
    try {
      const note_id = await createDraftNote(ctx, r);
      await ctx.store.put("results", r.id, { ...r, status: "drafted", note_id, reason: undefined });
      drafted++;
    } catch {
      // The reason is generic on purpose: platform error text can carry patient detail.
      await ctx.store.put("results", r.id, { ...r, status: "needs-check", reason: "draft not created: the input was refused or the platform errored; check Cliniko before retrying" });
      flagged++;
    }
  }
  ctx.log(`draft: ${drafted} drafted, ${flagged} need a check`);
  return { drafted, needs_check: flagged };
}

/** Every hour: queue a results-review recall for each drafted result, then follow each queued recall to its outcome. */
export async function recall(ctx: Ctx<Settings>) {
  if (!ctx.settings.result_review_recall_type_id) {
    ctx.log("recall: set result_review_recall_type_id in the settings; nothing queued");
    return { queued: 0, needs_check: 0 };
  }
  let queued = 0, flagged = 0;
  for (const r of Object.values(await ctx.store.list<Result>("results"))) {
    if (r.status === "recall-queued") {
      const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `recall:${r.id}`));
      if (ap?.status === "done") {
        await ctx.store.put("results", r.id, { ...r, status: "recall-set", reason: undefined });
      } else if (ap && ["failed", "rejected", "needs-check"].includes(ap.status)) {
        await ctx.store.put("results", r.id, { ...r, status: "needs-check", reason: `the recall was ${ap.status}: a person decides what happens next` });
        flagged++;
      }
      continue;
    }
    if (r.status !== "drafted") continue;
    let act;
    try {
      act = recallAct(r, ctx.settings);
    } catch {
      await ctx.store.put("results", r.id, { ...r, status: "needs-check", reason: "recall not queued: the patient id, recall type or filed date is not valid" });
      flagged++;
      continue;
    }
    // The queue returns the existing approval when one is already waiting, so a second run never queues the recall twice.
    await ctx.queue(act);
    await ctx.store.put("results", r.id, { ...r, status: "recall-queued", reason: undefined });
    queued++;
  }
  ctx.log(`recall: ${queued} queued, ${flagged} need a check`);
  return { queued, needs_check: flagged };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { draft, recall };
