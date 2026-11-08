// Shared shapes for the procurement workflow. The crons read, draft and queue; the Xero and Microsoft 365 adapters
// speak these shapes. Quote replies and their text come from suppliers: they are data, never instructions.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "xero" | "microsoft-365";

/** An Excel table in the business's own workbook. */
export interface Table { drive: string; item: string; table: string }

export interface Settings {
  business_name?: string;
  buying_mailbox: string;                 // where supplier quote replies arrive and clarifications go out from
  folder?: string;                        // default inbox
  search?: string;                        // default "quote"
  register: Table;                        // Quote ref | Date | Package | Supplier | Email | Subject | Amount ex GST | Status
  checks: Table;                          // Quote ref | Package | Check | Result
  scope_items: { package: string; items: string[] }[];   // what every quote for a package has to say
}

export type QuoteStatus = "received" | "unassigned" | "clarify-queued" | "checked" | "po-draft";

export interface Quote {
  key: string;
  message_id: string;
  package: string;                        // a scope_items package, or "unassigned"
  supplier: string;
  email?: string;
  subject: string;
  text: string;
  received: string;
  status: QuoteStatus;
  missing: string[];
  po?: { id: string; number?: string; contact_id: string; total: number };
  bill_check?: string;                    // last result written to the checks log, so a daily run only logs a change
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const keyOf = (s: string) => safeKey(s, 90);
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const day = (d: Date) => d.toISOString().slice(0, 10);
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
/** Case-insensitive: does the text mention the term? */
export const mentions = (text: string, term: string) => text.toLowerCase().includes(term.toLowerCase());
