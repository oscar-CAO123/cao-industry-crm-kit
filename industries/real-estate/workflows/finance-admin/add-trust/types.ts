// Shared shapes for the trust reconciliation workflow. It reads VaultRE trust data and drafts internal records; nothing moves money.
export interface Settings {
  business_name?: string;
  microsoft_365: { mailbox: string };                          // the finance mailbox: register rows and the exceptions email draft are made here
  principal_email?: string;                                    // the person who signs off the reconciliation (receives the exceptions draft)
  register?: { drive: string; item: string; table: string };   // the trust register workbook table
  sale_lives?: { property_id: number | string; life_id: number | string }[]; // the sales whose trust ledgers are read
  max_pages?: number;                                          // VaultRE ledger pages to read per sale (default 5)
}

export interface Tx {
  id: string;        // VaultRE trust ledger transaction id
  sale: string;      // "<property id>/<sale life id>"
  account: string;   // trust account id, empty when the platform does not name one
  date: string;      // transaction date, YYYY-MM-DD
  type: string;      // transaction type name as VaultRE gives it
  amount: number;    // amount as VaultRE reports it (no sign is assumed)
  receipt: string | null;
  contact: string | null;
}

export interface Account { id: string; name: string; active: boolean; seen: string }

export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const NUM = /^\d{1,15}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const text = (v: unknown, n: number) => String(v ?? "").slice(0, n);
/** Missing fields a person should check before the reconciliation is signed off. */
export const missing = (t: Tx): string => [!t.receipt && "no receipt number", !t.contact && "no contact", !t.account && "no trust account"].filter(Boolean).join(", ");
