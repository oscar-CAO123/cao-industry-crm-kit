// Shared shapes for the arrears ladder. The workflow reads and drafts; every reminder is queued and sent only when a person approves it.
export interface Settings {
  business_name?: string;
  microsoft_365: { mailbox: string };                        // the arrears mailbox: reminder drafts are made here and sent only on approval
  register?: { drive: string; item: string; table: string }; // the arrears register workbook table
  reminder_days?: number[];                                   // days overdue at which each reminder step goes (default 1 and 7)
  max_pages?: number;                                         // Re-Leased invoice pages to read per run (default 5)
}

export interface Arrear {
  id: string;            // Re-Leased invoice id
  display: string;       // invoice display id, e.g. INV-0001
  property: string;      // property address from the invoice
  contact: string;       // the invoice contact's name
  first: string;         // the invoice contact's first name, used in the greeting
  email: string | null;  // the invoice contact's email, when it is a valid address
  due: string;           // due date, YYYY-MM-DD
  amount: number;        // amount still owing, as Re-Leased reports it
  first_seen?: string;   // day the scan first found it
}

export interface Reminder { invoice: string; step: number; draft: string; approval: string; queued: string }

export const DAY = 864e5;
export const DEFAULT_LADDER = [1, 7];
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);
