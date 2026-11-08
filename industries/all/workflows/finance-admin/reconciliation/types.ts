// Shared shapes for the reconciliation workflow. Bank lines come from Xero, payouts from Stripe. Crons read, draft, queue.

export type Platform = "xero" | "stripe" | "myob";

export interface Settings {
  business_name?: string;
  bank_accounts: string[];          // Xero bank account AccountIDs (GUIDs) whose lines are reconciled
  processor: "stripe" | "none";     // where card and online payouts come from
  lookback_days?: number;           // how far back to read, default 60
  match_window_days?: number;       // how far apart a payout and its deposit can be, default 3
}

export interface BankLine {
  id: string;                       // Xero BankTransactionID
  account: string;                  // Xero AccountID of the bank account
  date: string;                     // YYYY-MM-DD
  amount: number;                   // AUD, signed: money in positive, money out negative
  type: string;                     // Xero BankTransaction Type, e.g. RECEIVE, SPEND
  reference: string;
  reconciled: boolean;
  status: string;                   // AUTHORISED, VOIDED, DELETED
}

export interface Payout {
  id: string;                       // Stripe payout id (po_...)
  date: string;                     // YYYY-MM-DD, the day Stripe created it
  amount: number;                   // net amount the bank should receive, in dollars
  currency: string;
}

export interface Item { kind: "bank" | "payout"; id: string; amount: number; date: string; reason: string }

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const INVOICE_NO = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
export const PAYOUT_ID = /^po_[A-Za-z0-9]{1,64}$/;
export const guid = (v: unknown): string => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("reconciliation: bad id"); return s; };
export const cents = (n: number) => Math.round(n * 100);
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const DAY = 864e5;
