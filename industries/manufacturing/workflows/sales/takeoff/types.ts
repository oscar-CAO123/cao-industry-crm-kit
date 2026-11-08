// Shared shapes for the manufacturing takeoff workflow. The helpers that carry no industry (money, escaping, the
// spreadsheet cell guard, the email check) come from the quoting workflow by relative import, not copied.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { money, esc, total, EMAIL, keyOf, day, cell, sendSummary, type Contact } from "../../../../construction/workflows/sales/quoting/types.ts";
export { money, esc, total, EMAIL, keyOf, day, cell, sendSummary };
export type { Contact };

export type Platform = "microsoft-365";
export type Table = { drive: string; item: string; table: string };

export interface Settings {
  family: "takeoff-from-drawings";
  intake: Platform[];            // where takeoff requests arrive
  takeoff: Platform;             // where the estimator's measured quantities are kept
  rate_card: Platform;           // where supplier and rate prices come from
  quotes: Platform;              // where the priced quote is drafted
  microsoft_365?: { mailbox: string; folder?: string; search?: string;
                    takeoff?: Table; rate_card?: Table; register?: Table };
  quote_valid_days?: number;
  gst_rate?: number;
  business_name?: string;
}

/** One measured quantity from the takeoff table: the job it belongs to, the item code and the quantity. */
export interface Measured { job: string; code: string; qty: number; unit?: string }
export interface RateItem { code: string; name: string; unit?: string; price: number; ref?: Record<string, string> }
export interface Line { code: string; name: string; qty: number; unitPrice: number; ref?: Record<string, string> }

export interface Enquiry {
  id: string; source: Platform; title: string; text?: string; contact: Contact; received: string;
  ref: Record<string, string>;   // job: the job reference read from the subject; message_id: the platform's id
  status: "new" | "needs-takeoff" | "needs-pricing" | "drafted";
  reason?: string; quote?: string;
}
export interface Quote {
  key: string; platform: Platform; enquiry: string; job: string; contact: Contact; lines: Line[]; total_ex_gst: number;
  status: "draft" | "sent"; ref: Record<string, string>; created: string; sent_at?: string;
}

export interface Adapter {
  id: Platform;
  enquiries(ctx: Ctx<Settings>): Promise<Omit<Enquiry, "status">[]>;
  takeoff(ctx: Ctx<Settings>): Promise<Measured[]>;
  rateCard(ctx: Ctx<Settings>): Promise<RateItem[]>;
  /** Write the register row, draft the quote, and queue its send for approval. Draft operations only, plus the queue. */
  draftQuote(ctx: Ctx<Settings>, e: Enquiry, lines: Line[]): Promise<Quote>;
}

/** A job reference such as "JB 2041", "JB-2041" or "JB2041", normalised to "JB2041". */
export const JOB = /\b[A-Z]{2,5}[- ]?\d{2,6}\b/i;
export const jobRef = (s: string) => { const m = JOB.exec(s); return m ? m[0].toUpperCase().replace(/[- ]/g, "") : undefined; };
/** Largest quantity a takeoff row may carry. Anything bigger is parked for a person to check. */
export const MAX_QTY = 100000;

/** The priced takeoff as a plain, escaped HTML table: used in the quote email. */
export function quoteHtml(s: Settings, q: { lines: Line[]; total_ex_gst: number }, intro: string): string {
  const gst = Math.round(q.total_ex_gst * (s.gst_rate ?? 0.1) * 100) / 100;
  const rows = q.lines.map((l) => `<tr><td>${esc(l.name)}</td><td align="right">${esc(l.qty)}</td><td align="right">${esc(money(l.unitPrice))}</td><td align="right">${esc(money(l.qty * l.unitPrice))}</td></tr>`).join("");
  return `<p>${esc(intro)}</p><table cellpadding="4"><tr><th align="left">Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>${rows}`
    + `<tr><td colspan="3" align="right">Total ex GST</td><td align="right">${esc(money(q.total_ex_gst))}</td></tr>`
    + `<tr><td colspan="3" align="right">GST</td><td align="right">${esc(money(gst))}</td></tr>`
    + `<tr><td colspan="3" align="right"><b>Total</b></td><td align="right"><b>${esc(money(q.total_ex_gst + gst))}</b></td></tr></table>`
    + `<p>Valid for ${esc(s.quote_valid_days ?? 30)} days.</p>`;
}
