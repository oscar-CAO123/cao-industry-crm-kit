// Shared shapes for the variations workflow. The ServiceM8 adapter speaks these.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "servicem8";

export interface Settings {
  business_name?: string;
  variation_words?: string[];                                       // words in a job note that mark it as extra work
  variation_templates?: { match: string; lines: { code: string; qty: number }[] }[];
  follow_up?: { after_days: number[] };
  quote_valid_days?: number;
  gst_rate?: number;
}

export interface Contact { name?: string; email?: string; phone?: string }
export interface Enquiry {
  id: string; source: Platform; title: string; text?: string; contact: Contact; received: string;
  ref?: Record<string, string>;
  status: "new" | "needs-pricing" | "drafted" | "skipped";
  reason?: string; variation?: string;
}
export interface RateItem { code: string; name: string; price: number }
export interface Line { code: string; name: string; qty: number; unitPrice: number }
export interface Variation {
  key: string; platform: Platform; enquiry: string; job: string; contact: Contact; lines: Line[]; total_ex_gst: number;
  status: "draft" | "sent"; ref: Record<string, string>; created: string; sent_at?: string; followups?: string[];
}

export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const total = (lines: Line[]) => Math.round(lines.reduce((a, l) => a + l.qty * l.unitPrice, 0) * 100) / 100;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE = /^\+[1-9]\d{6,14}$/;
export const keyOf = (s: string) => safeKey(s, 90);
/** What the approver sees: who, what, and the total. */
export const sendSummary = (what: string, to: string, v: { total_ex_gst: number; lines: Line[] }, priced?: boolean) =>
  `${what} to ${to}: ${v.lines.length} lines, ${money(v.total_ex_gst)} ex GST${priced ? " (prices set by proposal, check them)" : ""}`;

/** The variation as a plain, escaped HTML table: used in the approval summary and the client email. */
export function variationHtml(s: Settings, v: { lines: Line[]; total_ex_gst: number }, intro: string): string {
  const gst = Math.round(v.total_ex_gst * (s.gst_rate ?? 0.1) * 100) / 100;
  const rows = v.lines.map((l) => `<tr><td>${esc(l.name)}</td><td align="right">${esc(l.qty)}</td><td align="right">${esc(money(l.unitPrice))}</td><td align="right">${esc(money(l.qty * l.unitPrice))}</td></tr>`).join("");
  return `<p>${esc(intro)}</p><table cellpadding="4"><tr><th align="left">Extra work</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>${rows}`
    + `<tr><td colspan="3" align="right">Total ex GST</td><td align="right">${esc(money(v.total_ex_gst))}</td></tr>`
    + `<tr><td colspan="3" align="right">GST</td><td align="right">${esc(money(gst))}</td></tr>`
    + `<tr><td colspan="3" align="right"><b>Total</b></td><td align="right"><b>${esc(money(v.total_ex_gst + gst))}</b></td></tr></table>`
    + `<p>Valid for ${esc(s.quote_valid_days ?? 14)} days.</p>`;
}
