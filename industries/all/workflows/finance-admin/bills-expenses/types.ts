// Shared shapes for the bills and expenses workflow. A bill reaches the bills store (the agent skill writes it, see
// SKILL.md); the crons check it, enter it as a DRAFT bill in Xero, and queue its authorisation for a person.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "xero";

export interface Settings {
  business_name?: string;
  /** Xero tax type for a line that names none. INPUT is GST on purchases in Australia. */
  default_tax_type?: string;
  /** Days after the due date before an authorised bill is listed as overdue. */
  overdue_grace_days?: number;
}

export interface BillLine { description: string; amount: number; account_code: string; tax_type?: string }
export interface Bill {
  supplier: string;
  supplier_email?: string;
  invoice_number: string;
  /** The supplier's invoice date, YYYY-MM-DD. */
  date: string;
  due_date?: string;
  /** The purchase order the supplier quotes, if any. */
  po_number?: string;
  /** Amounts ex GST. */
  lines: BillLine[];
  /** Where the document came from, for the owner. Free text, data only. */
  source: string;
  received: string;
  status: "new" | "needs-coding" | "needs-review" | "duplicate" | "entered" | "skipped";
  reason?: string;
  ref?: Record<string, string>;
}

export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const total = (lines: BillLine[]) => Math.round(lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
export const keyOf = (s: string) => safeKey(s, 90);
export const DAY = 864e5;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const INVOICE_NO = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,99}$/;
const PO_NO = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$/;
const ACCOUNT = /^[A-Za-z0-9-]{1,10}$/;
const TAX = /^[A-Z_]{1,30}$/;

/** Plain text from a document: control characters out, length capped. Never HTML. */
export const cleanText = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

const realDay = (d: string) => ISO_DAY.test(d) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;

/** Returns the reason a bill cannot go to Xero, or null. Every value is checked before any network call. */
export function validate(b: Bill): string | null {
  if (!cleanText(b.supplier, 255)) return "supplier name is missing";
  if (!INVOICE_NO.test(String(b.invoice_number ?? ""))) return "invoice number is missing or has characters Xero should not get";
  if (!realDay(String(b.date ?? ""))) return "invoice date must be a real date, YYYY-MM-DD";
  if (b.due_date !== undefined && !realDay(String(b.due_date))) return "due date must be a real date, YYYY-MM-DD";
  if (b.po_number !== undefined && !PO_NO.test(String(b.po_number))) return "purchase order number has characters Xero should not get";
  if (b.supplier_email !== undefined && !EMAIL.test(String(b.supplier_email))) return "supplier email is not a valid address";
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 50) return "a bill needs 1 to 50 lines";
  for (const l of b.lines) {
    if (!cleanText(l.description, 4000)) return "a line has no description";
    if (!Number.isFinite(l.amount) || l.amount <= 0 || l.amount > 10_000_000) return "a line amount must be above 0 and at most 10 million";
    if (!ACCOUNT.test(String(l.account_code ?? ""))) return "a line has no valid account code";
    if (l.tax_type !== undefined && !TAX.test(String(l.tax_type))) return "a line has a tax type Xero should not get";
  }
  return null;
}
