// Shared shapes for the quoting workflow. Every adapter speaks these, so a step can point at any platform.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "servicem8" | "xero" | "microsoft-365";

export interface Settings {
  family: "service-minor-works" | "tender-from-plans";
  intake: Platform[];            // where new quote requests come from
  quotes: Platform;              // where the quote itself lives
  rate_card: Platform;           // where prices come from
  messages: Platform;            // how emails go out when the quote platform cannot send (Xero)
  microsoft_365?: { mailbox: string; folder?: string; search?: string;
                    rate_card?: { drive: string; item: string; table: string }; register?: { drive: string; item: string; table: string } };
  servicem8?: { quote_template_uuid?: string };
  job_templates?: { match: string; lines: { code: string; qty: number }[] }[];
  follow_up?: { after_days: number[]; channel?: "email" | "sms" };
  handover?: { on_accept: "xero-invoice-draft" | "none"; deposit_percent?: number };
  quote_valid_days?: number;
  gst_rate?: number;
  business_name?: string;
}

export interface Contact { name?: string; email?: string; phone?: string }
export interface Enquiry {
  id: string; source: Platform; title: string; text?: string; contact: Contact; received: string;
  ref?: Record<string, string>;
  status: "new" | "needs-pricing" | "drafted" | "skipped";
  reason?: string; quote?: string;
}
export interface RateItem { code: string; name: string; unit?: string; price: number; ref?: Record<string, string> }
export interface Line { code: string; name: string; qty: number; unitPrice: number; ref?: Record<string, string> }
export interface Quote {
  key: string; platform: Platform; enquiry: string; contact: Contact; lines: Line[]; total_ex_gst: number;
  status: "draft" | "sent" | "accepted" | "declined" | "invoiced";
  ref: Record<string, string>; created: string; sent_at?: string; followups?: string[]; accepted_at?: string; handed_over?: string;
}

export interface Adapter {
  id: Platform;
  enquiries?(ctx: Ctx<Settings>): Promise<Omit<Enquiry, "status">[]>;
  rateCard?(ctx: Ctx<Settings>): Promise<RateItem[]>;
  /** Draft the quote in this platform (draft operations only) and queue its send for approval. */
  draftQuote?(ctx: Ctx<Settings>, e: Enquiry, lines: Line[]): Promise<Quote>;
  /** Fresh status of quotes this platform holds (sent, accepted, declined). */
  refresh?(ctx: Ctx<Settings>, quotes: Quote[]): Promise<Quote[]>;
  /** Queue one follow-up message for approval. */
  followUp?(ctx: Ctx<Settings>, q: Quote, n: number): Promise<string>;
}

export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const total = (lines: Line[]) => Math.round(lines.reduce((a, l) => a + l.qty * l.unitPrice, 0) * 100) / 100;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE = /^\+[1-9]\d{6,14}$/;
export const keyOf = (s: string) => safeKey(s, 90);
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
/** What the approver sees: who, what, and the total. */
export const sendSummary = (what: string, to: string, q: { total_ex_gst: number; lines: Line[] }, priced?: boolean) =>
  `${what} to ${to}: ${q.lines.length} lines, ${money(q.total_ex_gst)} ex GST${priced ? " (prices set by proposal, check them)" : ""}`;
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** The quote as a plain, escaped HTML table: used in approval summaries and emails. */
export function quoteHtml(s: Settings, q: { lines: Line[]; total_ex_gst: number }, intro: string): string {
  const gst = Math.round(q.total_ex_gst * (s.gst_rate ?? 0.1) * 100) / 100;
  const rows = q.lines.map((l) => `<tr><td>${esc(l.name)}</td><td align="right">${esc(l.qty)}</td><td align="right">${esc(money(l.unitPrice))}</td><td align="right">${esc(money(l.qty * l.unitPrice))}</td></tr>`).join("");
  return `<p>${esc(intro)}</p><table cellpadding="4"><tr><th align="left">Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>${rows}`
    + `<tr><td colspan="3" align="right">Total ex GST</td><td align="right">${esc(money(q.total_ex_gst))}</td></tr>`
    + `<tr><td colspan="3" align="right">GST</td><td align="right">${esc(money(gst))}</td></tr>`
    + `<tr><td colspan="3" align="right"><b>Total</b></td><td align="right"><b>${esc(money(q.total_ex_gst + gst))}</b></td></tr></table>`
    + `<p>Valid for ${esc(s.quote_valid_days ?? 30)} days.</p>`;
}
