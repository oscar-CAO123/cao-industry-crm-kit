// Shared shapes for the loans workflow. The only platform built so far is Microsoft 365 (Outlook and Excel).

export type Platform = "microsoft-365";

export interface Settings {
  business_name?: string;
  microsoft_365: {
    mailbox: string;                       // the business's own enquiries mailbox
    folder?: string;                       // Outlook folder where enquiries land
    search?: string;                       // a word the enquiry subject must contain
    register: { drive: string; item: string; table: string };  // the loan register workbook table
  };
  documents: string[];                     // the standard list sent with every document request
}

export interface Contact { name?: string; email?: string }
export interface Enquiry {
  id: string; source: Platform; title: string; text?: string; contact: Contact; received: string;
  ref?: Record<string, string>;
  status: "new" | "drafted" | "skipped";
  reason?: string;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);
