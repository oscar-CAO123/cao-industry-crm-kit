// Shared shapes for the transport invoices workflow. Trips are entered into the store (no transport system is mapped yet),
// the rate card is the Xero item list, and the invoice lives in Xero.

export interface Settings {
  business_name?: string;
  due_days: number;                       // Xero DueDate, this many days after the invoice date
  sales_account_code?: string;            // Xero revenue account each line posts to
  chase_after_days_past_due?: number[];   // reminder n goes out once the invoice is this many days past due
}

export interface Customer { name?: string; email?: string }
export interface TripLine { code: string; qty: number }   // code is the Xero item code on the rate card

/** One completed trip. Keyed by its id in the "trips" namespace. Written by a person or the agent; the crons update status. */
export interface Trip {
  id: string;
  reference: string;                      // the customer's PO or docket number, used as the invoice reference
  customer: Customer;
  pod: boolean;                           // proof of delivery is signed and on file
  lines: TripLine[];
  status: "new" | "needs-check" | "drafted" | "authorised" | "paid" | "voided";
  reason?: string;
  contact_id?: string;                    // Xero ContactID
  invoice_id?: string;                    // Xero InvoiceID
  total_ex_gst?: number;
  amount_due?: number;
  due?: string;                           // YYYY-MM-DD
  sent?: boolean;                         // Xero SentToContact
  chased: string[];                       // ISO times each reminder was queued
  created: string;
}

export interface RateItem { code: string; name: string; price: number }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GUID = UUID;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const guid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("transport invoices: bad id"); return s; };

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
