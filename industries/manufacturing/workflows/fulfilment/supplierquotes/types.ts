// Shared shapes for the supplier quote comparison workflow. Crons read, draft and queue; nothing here sends.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365";

export interface Settings {
  business_name?: string;
  microsoft_365: {
    mailbox: string;                 // the buyer's own mailbox
    quote_folder?: string;           // where supplier replies land (default inbox)
    reply_search?: string;           // a word every quote reply carries (default Quote)
    register?: { drive: string; item: string; table: string };  // Excel table: Date | Comparison | Supplier | Email | Event | Detail
  };
  chase_after_days?: number[];       // cumulative days after the request for each chaser round (default 3, 7)
}

export interface Contact { name: string; email: string }
export interface SpecLine { item: string; qty: number; unit?: string; spec?: string }
export interface Reply { id: string; email: string; supplier: string; received: string; preview: string }
export interface Comparison {
  id: string;                        // the reference in every reply subject, letters digits dash or underscore
  title: string;
  created: string;                   // when the item list went to suppliers (ISO); chaser days count from here
  lines: SpecLine[];                 // the like-for-like item list the quotes must answer
  suppliers: Contact[];
  status: "open" | "closed";
  replies?: Reply[];                 // quotes received, one per supplier message
  reply_ids?: string[];              // reply message ids already logged
  compare_drafts?: Record<string, string>;   // reply count -> Outlook draft id of the comparison for that count
  chases?: number;                   // chaser rounds queued so far
  chase_drafts?: Record<string, string>;     // "round:email" -> Outlook draft id
}

export const CMP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const keyOf = (s: string) => safeKey(s, 90);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** The comparison as a plain, escaped HTML page for the buyer's Drafts. It lists what was asked, each quote as received,
 *  and who has not replied. It does not read prices or rank them: the estimator does that, like for like. */
export function comparisonHtml(c: Comparison): string {
  const rows = c.lines.map((l) => `<tr><td>${esc(l.item)}</td><td align="right">${esc(l.qty)}</td><td>${esc(l.unit ?? "")}</td><td>${esc(l.spec ?? "")}</td></tr>`).join("");
  const replied = new Set((c.replies ?? []).map((r) => r.email));
  const quotes = (c.replies ?? []).map((r) => `<h3>${esc(r.supplier)} (${esc(r.email)}), received ${esc(r.received)}</h3><blockquote>${esc(r.preview)}</blockquote>`).join("");
  const waiting = c.suppliers.filter((s) => !replied.has(s.email.toLowerCase())).map((s) => esc(s.name)).join(", ") || "none";
  return `<p>Quote comparison ${esc(c.id)}: ${esc(c.title)}</p>`
    + `<table cellpadding="4"><tr><th align="left">Item</th><th>Qty</th><th>Unit</th><th align="left">Spec</th></tr>${rows}</table>`
    + `<h2>Quotes received</h2>${quotes || "<p>None yet.</p>"}`
    + `<p>Still waiting: ${waiting}.</p>`
    + `<p>The estimator reads each price and checks it like for like before anything is awarded.</p>`;
}
