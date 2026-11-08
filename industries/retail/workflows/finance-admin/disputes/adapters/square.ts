// Square: disputes, refunds and text evidence for a dispute. Field names come from Square's official API spec
// (Dispute, DisputeEvidence, CreateDisputeEvidenceTextRequest, RefundPaymentRequest, ListPaymentRefundsResponse).
// Reads and staged evidence run on their own. A refund, a submit and an accept are only ever built as approval acts.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type DisputeRecord, type RefundRecord, type RefundDecision, type EvidenceNote, type Money,
         CURRENCY, EVIDENCE_TYPES, id, cents, money } from "../types.ts";

const P = "square";
const DAY = 864e5;
/** Square: an idempotency key is at most 45 characters and unique per request. */
const idem = (s: string) => safeKey(s, 45);

const locationParams = (s: Settings): Record<string, string> =>
  s.square?.location_id ? { location_id: id(s.square.location_id, "square location") } : {};

const moneyOf = (m: any): Money => {
  if (!m || m.currency !== CURRENCY) throw new Error("square: amount is not in AUD");
  return { cents: cents(m.amount), currency: CURRENCY };
};
const isoOrUndef = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined);

/** Every page of a Square list, at most ten pages. */
async function pages(ctx: Ctx<Settings>, op: string, key: string, params: Record<string, unknown>): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const r = await ctx.draft<any>({ platform: P, op, summary: `read ${op}`, input: { params: { ...params, ...(cursor ? { cursor } : {}) } } });
    out.push(...(Array.isArray(r.data?.[key]) ? r.data[key] : []));
    cursor = typeof r.data?.cursor === "string" && r.data.cursor ? r.data.cursor : undefined;
    if (!cursor) break;
  }
  return out;
}

/** Disputes as they stand now. A record that fails validation is counted as skipped, never stored. */
export async function listDisputes(ctx: Ctx<Settings>, seen: string): Promise<{ disputes: DisputeRecord[]; skipped: number }> {
  const raw = await pages(ctx, "api.ListDisputes", "disputes", locationParams(ctx.settings));
  const disputes: DisputeRecord[] = [];
  let skipped = 0;
  for (const d of raw) {
    try {
      disputes.push({
        id: id(d.id, "square dispute"), platform: P, state: String(d.state ?? ""), reason: String(d.reason ?? "").slice(0, 60),
        amount: moneyOf(d.amount_money), due_at: isoOrUndef(d.due_at),
        payment_id: d.disputed_payment?.payment_id ? id(d.disputed_payment.payment_id, "square payment") : undefined,
        evidence_ids: (Array.isArray(d.evidence_ids) ? d.evidence_ids : []).slice(0, 100).map((x: unknown) => id(x, "square evidence")),
        seen, staged: [],
      });
    } catch { skipped++; }
  }
  return { disputes, skipped };
}

/** Refunds made in the lookback window. */
export async function listRefunds(ctx: Ctx<Settings>, seen: string, now: Date): Promise<{ refunds: RefundRecord[]; skipped: number }> {
  const days = Math.min(365, Math.max(1, Math.floor(Number(ctx.settings.lookback_days ?? 30))));
  const begin = new Date(now.getTime() - days * DAY).toISOString();
  const raw = await pages(ctx, "api.ListPaymentRefunds", "refunds", { ...locationParams(ctx.settings), begin_time: begin, limit: 100 });
  const refunds: RefundRecord[] = [];
  let skipped = 0;
  for (const r of raw) {
    try {
      refunds.push({
        id: id(r.id, "square refund"), platform: P, status: String(r.status ?? ""),
        payment_id: r.payment_id ? id(r.payment_id, "square payment") : undefined, amount: moneyOf(r.amount_money),
        reason: typeof r.reason === "string" ? r.reason.slice(0, 192) : undefined, created_at: isoOrUndef(r.created_at), seen,
      });
    } catch { skipped++; }
  }
  return { refunds, skipped };
}

/** Stage one text item of evidence on a dispute. Square keeps it on the dispute until a submit is approved. */
export async function stageEvidence(ctx: Ctx<Settings>, disputeId: string, note: EvidenceNote): Promise<string> {
  const did = id(disputeId, "square dispute");
  if (!(EVIDENCE_TYPES as readonly string[]).includes(note.evidence_type)) throw new Error("square: evidence type not allowed");
  const text = String(note.text ?? "").trim();
  if (!text || text.length > 500) throw new Error("square: evidence text must be 1 to 500 characters");
  const r = await ctx.draft<any>({ platform: P, op: "api.CreateDisputeEvidenceText", summary: `stage ${note.evidence_type} on dispute ${did}`,
    input: { params: { dispute_id: did }, body: { idempotency_key: idem(`evidence:${did}:${note.evidence_type}`), evidence_type: note.evidence_type, evidence_text: text } } });
  return id(r.data?.evidence?.id, "square evidence");
}

/** The approval act that refunds one payment. Built only from a validated decision. */
export function refundAct(requestId: string, d: RefundDecision) {
  const rid = id(requestId, "refund request");
  const pid = id(d.payment_id, "square payment");
  const amount = cents(d.amount_cents);
  const reason = d.reason ? String(d.reason).slice(0, 192) : undefined;
  return {
    platform: P, op: "api.RefundPayment", key: `refund:${rid}`,
    input: { body: { idempotency_key: idem(`refund:${rid}`), payment_id: pid, amount_money: { amount, currency: CURRENCY }, ...(reason ? { reason } : {}) } },
    summary: `refund ${money({ cents: amount, currency: CURRENCY })} on payment ${pid}${reason ? ` (${reason})` : ""}`,
  };
}

/** The approval act that sends the staged evidence to the bank. */
export function submitAct(disputeId: string) {
  const did = id(disputeId, "square dispute");
  return { platform: P, op: "api.SubmitEvidence", key: `submit:${did}`, input: { params: { dispute_id: did } },
           summary: `submit the staged evidence for dispute ${did} to the bank` };
}

/** The approval act that accepts the chargeback. The business gives the money back. */
export function acceptAct(disputeId: string) {
  const did = id(disputeId, "square dispute");
  return { platform: P, op: "api.AcceptDispute", key: `accept:${did}`, input: { params: { dispute_id: did } },
           summary: `accept dispute ${did}: the business gives the disputed money back` };
}
