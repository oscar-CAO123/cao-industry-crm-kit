// Shared shapes for the gift cards and loyalty workflow. Square is the only platform here with mapped operations.
// Fresha and Lightspeed have no ops file in the kit, so they are listed in workflow.json gaps, not given adapters.
import crypto from "node:crypto";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "square";

export interface Settings {
  business_name: string;
  location_id: string;            // the Square location that sells cards and enrols members
  loyalty_program_id?: string;    // the Square loyalty program new members join (needed before any enrolment)
  activity_days?: number;         // the first activity read looks back this many days (default 7, 1 to 90)
  per_run?: number;               // requests queued per run (default 20, 1 to 100)
  max_pages?: number;             // activity pages read per run (default 10, 1 to 50)
}

export type Kind = "gift-card" | "loyalty-enrol";
export type Status =
  | "new" | "issue-queued" | "issued" | "activate-queued" | "activated"
  | "enrol-queued" | "enrolled" | "skipped";

/** A sale or enrolment request. Staff or the CRM shell write these; the crons read them and queue approvals. */
export interface Request {
  key: string;
  kind: Kind;
  status: Status;
  amount_cents?: number;     // gift card face value in cents (AUD), whole cents from 100 to 500000
  order_id?: string;         // gift cards: the paid Square order that funds the card, set by staff after the sale
  phone?: string;            // loyalty: the member's phone in E.164 format
  customer_id?: string;      // loyalty or gift card: the Square customer, when known
  gift_card_id?: string;
  loyalty_account_id?: string;
  approval?: string;         // the approval that issues the card or enrols the member
  activate_approval?: string;
  reason?: string;
  created: string;
}

/** One gift card activity (sale, load, redemption, refund...) as the ledger keeps it. */
export interface LedgerRow {
  key: string;               // the Square activity id
  type: string;              // ACTIVATE, LOAD, REDEEM, REFUND and the other Square activity types
  gift_card_id?: string;
  amount_cents?: number;
  at: string;
  location_id: string;
}

export interface LoyaltyMember { key: string; id: string; balance?: number; checked_at?: string }

export const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const PHONE = /^\+[1-9]\d{6,14}$/;
export const keyOf = (s: string) => safeKey(s, 90);
/** A Square idempotency key (at most 128 characters), stable for the same request so a repeat never creates twice. */
export const idem = (prefix: string, s: string) => `${prefix}-${crypto.createHash("sha256").update(s).digest("hex").slice(0, 40)}`;
export const money = (cents: number) => ({ amount: cents, currency: "AUD" as const });
export const validCents = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 100 && (n as number) <= 500000;
export const within = (v: number | undefined, lo: number, hi: number, dflt: number) => Math.min(Math.max(Math.trunc(v ?? dflt), lo), hi);
export const dollars = (cents: number) => `AUD ${(cents / 100).toFixed(2)}`;
export const DAY = 864e5;

/** Settings that reach a request path or a body are checked before any network call. */
export function checkSettings(s: Settings): void {
  if (!ID.test(String(s.location_id ?? ""))) throw new Error("gift-cards-loyalty: location_id must be a plain Square id");
  if (s.loyalty_program_id !== undefined && !ID.test(String(s.loyalty_program_id))) throw new Error("gift-cards-loyalty: loyalty_program_id must be a plain Square id");
}
