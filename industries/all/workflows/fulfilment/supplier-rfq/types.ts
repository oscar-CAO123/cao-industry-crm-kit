// Shared shapes for the supplier RFQ workflow. Crons read, draft and queue; nothing here sends.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365" | "xero";

export interface Settings {
  business_name?: string;
  microsoft_365: {
    mailbox: string;                 // the buyer's own mailbox
    rfq_folder?: string;             // where supplier replies land (default inbox)
    reply_search?: string;           // a word every RFQ subject carries (default RFQ)
    register?: { drive: string; item: string; table: string };  // Excel table: Date | RFQ | Supplier | Email | Event | Detail
  };
  chase_after_days?: number[];       // cumulative days after issue for each chaser round (default 3, 7)
}

export interface Contact { name: string; email: string }
export interface RfqLine { item: string; qty: number; unit?: string; spec?: string }
export interface Award {
  supplier: Contact;
  xero_contact_id: string;           // the supplier's ContactID in Xero, set by a person
  lines: { item: string; qty: number; unitPrice: number }[];   // prices from the chosen reply, set by a person
}
export interface Rfq {
  id: string;                        // the reference in every subject, letters digits dash or underscore
  title: string;
  needed_by?: string;
  lines: RfqLine[];
  suppliers: Contact[];
  status: "new" | "issued";
  sent?: string[];                   // supplier emails whose RFQ is queued for approval
  drafts?: Record<string, string>;   // supplier email -> Outlook draft id (created once, reused on re-runs)
  issued_at?: string;
  chases?: number;                   // chaser rounds queued so far
  chase_drafts?: Record<string, string>;  // "round:email" -> Outlook draft id
  replied?: string[];                // lower-case supplier emails that have replied
  reply_ids?: string[];              // reply message ids already logged
  award?: Award;
  po?: { id: string; drafted: string };
}

export const RFQ_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const keyOf = (s: string) => safeKey(s, 90);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** The RFQ as a plain, escaped HTML table, sent to one supplier. */
export function rfqHtml(s: Settings, rfq: Rfq, to: Contact): string {
  const rows = rfq.lines.map((l) => `<tr><td>${esc(l.item)}</td><td align="right">${esc(l.qty)}</td><td>${esc(l.unit ?? "")}</td><td>${esc(l.spec ?? "")}</td></tr>`).join("");
  return `<p>Hi ${esc(to.name || "there")},</p>`
    + `<p>Could you price the items below for ${esc(s.business_name ?? "us")}?${rfq.needed_by ? ` We need them by ${esc(rfq.needed_by)}.` : ""}</p>`
    + `<table cellpadding="4"><tr><th align="left">Item</th><th>Qty</th><th>Unit</th><th align="left">Spec</th></tr>${rows}</table>`
    + `<p>Reply with your price, lead time and any exclusions. Please keep ${esc(rfq.id)} in the subject.</p>`;
}
