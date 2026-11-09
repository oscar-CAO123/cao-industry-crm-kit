// Stripe: disputes and refunds read as drafts. A refund and the evidence submission are live operations: they are only
// ever queued, and run when a person approves them. Field names come from Stripe's own OpenAPI spec (the dispute object,
// dispute_evidence, the update-dispute body, the refund create body and GET /v1/disputes, /v1/refunds), read from
// endpoint-map/raw/stripe/spec. Stripe takes form-encoded bodies; the SDK encodes them the way stripe-node does.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type DisputeRecord, type RefundRecord, type RefundDecision, type EvidenceNote, type Money,
         CURRENCY, EVIDENCE_TYPES, id, cents, money } from "../types.ts";

const P = "stripe";
const DAY = 864e5;
const LIST_DISPUTES = "openapi_spec3.GetDisputes";
const LIST_REFUNDS = "openapi_spec3.GetRefunds";
const REFUND = "openapi_spec3.PostRefunds";
const UPDATE_DISPUTE = "openapi_spec3.PostDisputesDispute";

/** A Stripe amount: integer minor units in a three-letter currency code (lower case on the wire). */
const amountOf = (amount: unknown, currency: unknown): Money => {
  if (typeof currency !== "string" || currency.toUpperCase() !== CURRENCY) throw new Error("stripe: amount is not in AUD");
  return { cents: cents(amount), currency: CURRENCY };
};
/** The payment intent of a dispute or refund: an id, or the expanded object that carries one. */
const payIntentOf = (v: unknown): string | undefined => {
  const x = typeof v === "string" ? v : v && typeof v === "object" ? (v as { id?: unknown }).id : undefined;
  return x === undefined || x === null ? undefined : id(x, "stripe payment intent");
};
const isoFromUnix = (v: unknown): string | undefined => (typeof v === "number" && v > 0 ? new Date(v * 1000).toISOString() : undefined);

/** Every page of a Stripe list (newest first), at most ten pages of 100. Stops early once a page is older than olderThan (ms). */
async function pages(ctx: Ctx<Settings>, op: string, olderThan?: number): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  for (let i = 0; i < 10; i++) {
    const r = await ctx.draft<any>({ platform: P, op, summary: `read ${op}`,
      input: { params: { limit: 100, ...(after ? { starting_after: after } : {}) } } });
    const rows: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    out.push(...rows);
    if (!r.data?.has_more || !rows.length) break;
    const last = rows[rows.length - 1];
    if (olderThan !== undefined && typeof last?.created === "number" && last.created * 1000 < olderThan) break;
    after = String(last.id);
  }
  return out;
}

/** Disputes as they stand now. A record that fails validation is counted as skipped, never stored. */
export async function listDisputes(ctx: Ctx<Settings>, seen: string): Promise<{ disputes: DisputeRecord[]; skipped: number }> {
  const raw = await pages(ctx, LIST_DISPUTES);
  const disputes: DisputeRecord[] = [];
  let skipped = 0;
  for (const d of raw) {
    try {
      disputes.push({
        id: id(d.id, "stripe dispute"), platform: P, state: String(d.status ?? ""), reason: String(d.reason ?? "").slice(0, 60),
        amount: amountOf(d.amount, d.currency), due_at: isoFromUnix(d.evidence_details?.due_by),
        payment_id: payIntentOf(d.payment_intent), evidence_ids: [], seen, staged: [],
      });
    } catch { skipped++; }
  }
  return { disputes, skipped };
}

/** Refunds made in the lookback window. */
export async function listRefunds(ctx: Ctx<Settings>, seen: string, now: Date): Promise<{ refunds: RefundRecord[]; skipped: number }> {
  const days = Math.min(365, Math.max(1, Math.floor(Number(ctx.settings.lookback_days ?? 30))));
  const beginMs = now.getTime() - days * DAY;
  const raw = await pages(ctx, LIST_REFUNDS, beginMs);
  const refunds: RefundRecord[] = [];
  let skipped = 0;
  for (const r of raw) {
    if (typeof r.created === "number" && r.created * 1000 < beginMs) continue;
    try {
      refunds.push({
        id: id(r.id, "stripe refund"), platform: P, status: String(r.status ?? ""), payment_id: payIntentOf(r.payment_intent),
        amount: amountOf(r.amount, r.currency), reason: typeof r.reason === "string" ? r.reason.slice(0, 192) : undefined,
        created_at: isoFromUnix(r.created), seen,
      });
    } catch { skipped++; }
  }
  return { refunds, skipped };
}

/** The approval act that refunds one payment intent. Built only from a validated decision. Stripe's reason list is fixed,
 *  so the decision's own words go to metadata, never to the reason field. */
export function refundAct(requestId: string, d: RefundDecision) {
  const rid = id(requestId, "refund request");
  const pi = id(d.payment_id, "stripe payment intent");
  if (!/^pi_[A-Za-z0-9]+$/.test(pi)) throw new Error("stripe: a refund needs a payment intent id (pi_...)");
  const amount = cents(d.amount_cents);
  const note = d.reason ? String(d.reason).slice(0, 500) : undefined;
  return {
    platform: P, op: REFUND, key: `refund:${rid}`,
    input: { body: { payment_intent: pi, amount, ...(note ? { metadata: { kit_reason: note } } : {}) } },
    summary: `refund ${money({ cents: amount, currency: CURRENCY })} on payment ${pi}${note ? ` (${note.slice(0, 80)})` : ""} (stripe)`,
  };
}

/** The approval act that submits the written evidence to the bank. Stripe submits on update (submit: true), and the
 *  note goes in its one generic text field. The evidence type is checked but not sent, because Stripe has no such field. */
export function submitAct(disputeId: string, note: EvidenceNote) {
  const did = id(disputeId, "stripe dispute");
  if (!(EVIDENCE_TYPES as readonly string[]).includes(note.evidence_type)) throw new Error("stripe: evidence type not allowed");
  const text = String(note.text ?? "").trim();
  if (!text || text.length > 500) throw new Error("stripe: evidence text must be 1 to 500 characters");
  return {
    platform: P, op: UPDATE_DISPUTE, key: `submit:${did}`,
    input: { params: { dispute: did }, body: { evidence: { uncategorized_text: text }, submit: true } },
    summary: `submit the written evidence for dispute ${did} to the bank (stripe)`,
  };
}
