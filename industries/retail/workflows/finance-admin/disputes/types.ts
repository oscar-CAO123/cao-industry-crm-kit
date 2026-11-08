// Shared shapes for the refund and chargeback workflow. Square is the one adapter built; the rest are in workflow.json gaps.
export type Platform = "square";

export interface Settings {
  business_name?: string;
  square?: { location_id?: string };
  lookback_days?: number;      // refunds are read this far back (default 30)
  flag_within_days?: number;   // an open dispute with no decision this close to its deadline is flagged (default 3)
}

export const CURRENCY = "AUD";

/** Square's dispute states that still need a response from the business. */
export const OPEN_STATES = new Set(["EVIDENCE_REQUIRED", "INQUIRY_EVIDENCE_REQUIRED"]);

/** Evidence types Square accepts on a text item (CreateDisputeEvidenceTextRequest.evidence_type). */
export const EVIDENCE_TYPES = [
  "GENERIC_EVIDENCE", "CANCELLATION_OR_REFUND_DOCUMENTATION", "CARDHOLDER_COMMUNICATION", "PRODUCT_OR_SERVICE_DESCRIPTION",
  "RECEIPT", "PROOF_OF_DELIVERY_DOCUMENTATION", "SERVICE_RECEIVED_DOCUMENTATION", "REBUTTAL_EXPLANATION", "TRACKING_NUMBER",
  "DUPLICATE_CHARGE_DOCUMENTATION", "PURCHASE_ACKNOWLEDGEMENT", "RELATED_TRANSACTION_DOCUMENTATION",
] as const;
export type EvidenceType = typeof EVIDENCE_TYPES[number];

export interface Money { cents: number; currency: string }

export interface DisputeRecord {
  id: string; platform: Platform; state: string; reason: string; amount: Money; due_at?: string; payment_id?: string;
  evidence_ids: string[]; seen: string;
  /** evidence types already staged on Square for this dispute */
  staged: EvidenceType[];
}
export interface RefundRecord { id: string; platform: Platform; status: string; payment_id?: string; amount: Money; reason?: string; created_at?: string; seen: string }

/** Written by a person or the agent (namespace "evidence", key = dispute id). The watch cron stages it on Square. */
export interface EvidenceNote { evidence_type: EvidenceType; text: string; written_by: string }
/** Written by a person or the agent (namespace "refund_decisions", key = request id). Only "refund" is ever queued. */
export interface RefundDecision { platform: Platform; payment_id: string; amount_cents: number; reason?: string; decision: "refund" | "decline"; decided_by: string }
/** Written only after the owner says so (namespace "dispute_decisions", key = dispute id). */
export interface DisputeDecision { decision: "submit" | "accept"; decided_by: string }

/** A value from outside the business: an id, a cent amount. Anything else is refused before it reaches a request. */
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
export const id = (v: unknown, what: string): string => {
  const s = typeof v === "string" ? v : "";
  if (!ID.test(s)) throw new Error(`${what}: bad id`);
  return s;
};
export const cents = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 100_000_000) throw new Error("bad amount");
  return n;
};
export const money = (m: Money) => `$${(m.cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${m.currency}`;
