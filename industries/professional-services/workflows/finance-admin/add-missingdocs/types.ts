// Shared shapes for the missing documents finder. Xero is the only platform with mapped operations for this job.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface Settings {
  business_name?: string;
  messages?: "microsoft-365";           // how chase emails go out: an Outlook draft, sent only on approval
  microsoft_365?: { mailbox: string };  // the practice's own mailbox
  lookback_days?: number;               // how far back to look, 1 to 365, default 90
  chase_after_days?: number[];          // days after the previous chase for the 2nd and 3rd reminder, default [7, 14]
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const DAY = 864e5;

/** One Xero item with no document attached: a bank transaction or a bill (supplier invoice). */
export interface Missing {
  key: string;
  kind: "bank-transaction" | "bill";
  xero_id: string;
  contact_id?: string;
  contact?: string;
  email?: string;
  date: string;
  reference?: string;
  description?: string;
  amount: number;
  seen: string;
  status: "missing" | "cleared";        // cleared = not in the latest scan any more
}

/** The chase state for one client: which reminder went last, when, and under which approval key. */
export interface Chase { stage: number; last: string; key: string }

export const keyOf = (s: string) => safeKey(s, 120);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function lookback(s: Settings): number {
  const n = Number(s.lookback_days ?? 90);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error("lookback_days must be a whole number from 1 to 365");
  return n;
}
