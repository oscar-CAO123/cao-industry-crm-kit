// Shared shapes for the grower statements workflow. Only Xero is mapped for this job.

export interface Settings {
  business_name?: string;
  bank_account_code: string; // Xero code of the bank account grower payments leave from
}

/** A deduction in dollars, ex GST, always positive. */
export interface Charge { label: string; amount: number }

export interface Statement {
  key: string; grower: string; period_end: string; gross: number; charges: Charge[];
  net: number; xero_amount_due: number; drafted: string;
}

/** One grower's pack-out for one period. Written into the store by the CRM shell, never by a cron. */
export interface Packout {
  key: string;             // stable id, e.g. "grower-a-2026-10-31"
  grower: string;          // the grower's name as the packhouse records it
  xero_contact_id: string; // the grower's contact GUID in Xero
  bill_invoice_id: string; // the grower's supplier bill in Xero that this statement pays (GUID)
  period_end: string;      // YYYY-MM-DD
  gross: number;           // pack-out value before charges, ex GST
  charges: Charge[];
  status: "new" | "held" | "queued" | "paid";
  reason?: string;
  approval?: string;       // approval id, once the payment is queued
  statement?: Statement;
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ACCOUNT = /^[A-Za-z0-9]{1,10}$/;

export const guid = (v: unknown) => {
  const s = String(v ?? "");
  if (!GUID.test(s)) throw new Error("packout: bad id");
  return s;
};
export const cents = (n: number) => Math.round(n * 100) / 100;
export const isMoney = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n < 1e9;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const netOf = (p: Packout) => cents(p.gross - p.charges.reduce((a, c) => a + c.amount, 0));

/** Why a pack-out cannot be stated, or null when it can. Checks every id and number before it reaches a call or a sum. */
export function problem(p: Packout): string | null {
  try { guid(p.xero_contact_id); guid(p.bill_invoice_id); } catch { return "a Xero id is not a GUID"; }
  if (!DATE.test(String(p.period_end))) return "period end is not a date";
  if (!isMoney(p.gross) || p.gross <= 0) return "gross is not a positive amount";
  if (!Array.isArray(p.charges) || p.charges.some((c) => typeof c?.label !== "string" || !isMoney(c.amount))) return "a charge is not valid";
  if (netOf(p) <= 0) return "charges leave nothing to pay";
  return null;
}
