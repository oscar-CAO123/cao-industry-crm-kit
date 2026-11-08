// Shared shapes for the invoicing workflow. Completed jobs come from ServiceM8, the invoice lives in Xero.

export type Platform = "servicem8" | "xero";

export interface Settings {
  business_name?: string;
  due_days: number;                       // Xero DueDate, this many days after the invoice date
  sales_account_code?: string;            // Xero revenue account each line posts to
  bank_account_code?: string;             // Xero bank account that payments land in
  mark_invoice_sent?: boolean;            // set invoice_sent on the ServiceM8 job once the invoice email has gone
  chase_after_days_past_due?: number[];   // reminder n goes out once the invoice is this many days past due
}

export interface Contact { name?: string; email?: string }
export interface Line { name: string; qty: number; unitPrice: number }

/** One completed job and the invoice drafted for it. Keyed by the ServiceM8 job uuid. */
export interface InvoiceRecord {
  job: string;
  status: "needs-lines" | "drafted" | "authorised" | "paid" | "voided";
  reason?: string;
  invoice_id?: string;                    // Xero InvoiceID
  contact_id?: string;
  email?: string;
  total_ex_gst?: number;
  amount_due?: number;
  due?: string;                           // YYYY-MM-DD
  sent?: boolean;                         // Xero SentToContact
  chased: string[];                       // ISO times each reminder was queued
  created: string;
}

/** One ServiceM8 job payment and what became of it. Keyed by the payment uuid. */
export interface PaymentRecord { job: string; invoice?: string; amount?: number; status: "queued" | "parked" | "skipped"; reason?: string }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GUID = UUID;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("invoicing: bad uuid"); return s; };
export const guid = uuid;

export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
export const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5;

/** Xero dates arrive as "/Date(ms+0000)/" or as ISO text. Returns YYYY-MM-DD, or undefined. */
export function xeroDate(v: unknown): string | undefined {
  const s = String(v ?? "");
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const ms = /\/Date\((-?\d+)/.exec(s);
  const t = ms ? Number(ms[1]) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}
