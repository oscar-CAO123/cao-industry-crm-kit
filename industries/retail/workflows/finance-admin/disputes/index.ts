// The refund and chargeback crons. Each one reads, records, stages or queues. None refunds, submits or accepts directly:
// those run only when a person approves the queued act in the CRM shell. Judgment (what the evidence says, whether to
// refund) belongs to the agent skill in SKILL.md, which writes its decisions into the store.
import type { Act, Ctx } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import type { DisputeDecision, DisputeRecord, EvidenceNote, RefundDecision, Settings } from "./types.ts";
import { OPEN_STATES } from "./types.ts";
import { listDisputes, listRefunds, stageEvidence, refundAct, submitAct, acceptAct } from "./adapters/square.ts";
import * as stripe from "./adapters/stripe.ts";

const DAY = 864e5;

/** Queue an act once: a cron that runs again never queues the same thing twice. Returns true when it queued now. */
async function queueOnce(ctx: Ctx<Settings>, act: Act): Promise<boolean> {
  const key = act.key ?? "";
  if (!key) throw new Error("an approval needs a key");
  if (await ctx.store.get("approvals", approvalId(ctx.workflow.id, key))) return false;
  await ctx.queue(act, act.summary);
  return true;
}

/** Stripe is read only when the client has switched it on in settings. */
const stripeOn = (ctx: Ctx<Settings>) => ctx.settings.stripe?.enabled === true;

/** Every 30 minutes: read disputes and recent refunds, record them, and stage the evidence notes a person has written.
 *  Square holds staged evidence on the dispute; a Stripe note is sent with its submit, so nothing is staged for Stripe here. */
export async function watch(ctx: Ctx<Settings>) {
  const seen = ctx.now.toISOString();
  const sq = await listDisputes(ctx, seen);
  const sqRefunds = await listRefunds(ctx, seen, ctx.now);
  const st = stripeOn(ctx) ? await stripe.listDisputes(ctx, seen) : { disputes: [], skipped: 0 };
  const stRefunds = stripeOn(ctx) ? await stripe.listRefunds(ctx, seen, ctx.now) : { refunds: [], skipped: 0 };
  const disputes = [...sq.disputes, ...st.disputes];
  const refunds = [...sqRefunds.refunds, ...stRefunds.refunds];
  const badDisputes = sq.skipped + st.skipped, badRefunds = sqRefunds.skipped + stRefunds.skipped;
  let staged = 0, stageFailed = 0;
  for (const d of disputes) {
    const prev = await ctx.store.get<DisputeRecord>("disputes", d.id);
    d.staged = prev?.staged ?? [];
    if (d.platform === "square" && OPEN_STATES.has(d.state)) {
      const note = await ctx.store.get<EvidenceNote>("evidence", d.id);
      if (note && !d.staged.includes(note.evidence_type)) {
        try {
          await stageEvidence(ctx, d.id, note);
          d.staged.push(note.evidence_type);
          staged++;
        } catch (e: any) {
          stageFailed++;
          ctx.log(`evidence not staged on ${d.id}: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
    }
    await ctx.store.put("disputes", d.id, d);
  }
  for (const r of refunds) await ctx.store.put("refunds", r.id, r);
  ctx.log(`watch: ${disputes.length} disputes, ${refunds.length} refunds, ${staged} evidence staged`);
  return { disputes: disputes.length, refunds: refunds.length, staged, stage_failed: stageFailed, skipped: badDisputes + badRefunds };
}

/** Every 15 minutes: queue each refund a person has decided on. A refund is queued here, never run here. */
export async function refunds(ctx: Ctx<Settings>) {
  const decisions = await ctx.store.list<RefundDecision>("refund_decisions");
  let queued = 0, declined = 0, invalid = 0;
  for (const [req, d] of Object.entries(decisions)) {
    if (d.decision === "decline") { declined++; continue; }
    if (d.decision !== "refund" || (d.platform !== "square" && d.platform !== "stripe")) continue;
    try {
      if (d.platform === "stripe" && !stripeOn(ctx)) throw new Error("stripe is not switched on for this workflow");
      const act = d.platform === "stripe" ? stripe.refundAct(req, d) : refundAct(req, d);
      if (await queueOnce(ctx, act)) queued++;
    } catch (e: any) {
      invalid++;
      ctx.log(`refund decision not queued: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  ctx.log(`refunds: ${queued} queued, ${declined} declined, ${invalid} invalid`);
  return { queued, declined, invalid };
}

/** Every hour: queue the submit or accept a person has decided on, and flag open disputes near their deadline with no decision. */
export async function respond(ctx: Ctx<Settings>) {
  const decisions = await ctx.store.list<DisputeDecision>("dispute_decisions");
  const disputes = await ctx.store.list<DisputeRecord>("disputes");
  const within = (ctx.settings.flag_within_days ?? 3) * DAY;
  let queued = 0, invalid = 0;
  const flagged: string[] = [], held: string[] = [];
  for (const d of Object.values(disputes)) {
    if (!OPEN_STATES.has(d.state)) continue;
    if (d.platform === "stripe" && !stripeOn(ctx)) continue;
    const dec = decisions[d.id];
    if (!dec) {
      if (d.due_at && Date.parse(d.due_at) - ctx.now.getTime() < within) flagged.push(d.id);
      continue;
    }
    try {
      if (dec.decision === "accept") {
        if (d.platform === "stripe") throw new Error("accepting a Stripe dispute (closing it) is not built yet");
        if (await queueOnce(ctx, acceptAct(d.id))) queued++;
      } else if (dec.decision === "submit") {
        if (d.platform === "stripe") {
          const note = await ctx.store.get<EvidenceNote>("evidence", d.id);
          if (!note) { held.push(d.id); continue; }   // no written evidence yet: never submit an empty dispute
          if (await queueOnce(ctx, stripe.submitAct(d.id, note))) queued++;
        } else {
          if (!d.staged.length) { held.push(d.id); continue; }   // nothing staged yet: never submit an empty file
          const note = await ctx.store.get<EvidenceNote>("evidence", d.id);
          if (await queueOnce(ctx, submitAct(d.id, { types: d.staged, text: note?.text }))) queued++;
        }
      }
    } catch (e: any) {
      invalid++;
      ctx.log(`dispute decision not queued: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  if (flagged.length) ctx.log(`respond: ${flagged.length} open dispute(s) near deadline with no decision`);
  if (held.length) ctx.log(`respond: ${held.length} dispute(s) decided to submit with no evidence staged`);
  ctx.log(`respond: ${queued} queued`);
  return { queued, invalid, flagged: flagged.length, held: held.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { watch, refunds, respond };
