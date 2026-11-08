// Shared shapes for the bond lodgement workflow. The workflow reads and drafts only; lodging with a state bond authority is done by a person.
export interface Settings {
  business_name?: string;
  notify: string;                                  // the team address that receives reminders to claim or release a bond
  microsoft_365: { mailbox: string };              // the bonds mailbox: drafts are created here and sent only on approval
  register?: { drive: string; item: string; table: string }; // the bond register workbook table
  max_pages?: number;                              // VaultRE pages to read per run (default 5)
}

export interface Tenancy {
  id: string;
  property: string;
  start: string | null;
  end: string | null;
  bond_receipted: number | null;
  archived: boolean;
}

export const DAY = 864e5;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);
