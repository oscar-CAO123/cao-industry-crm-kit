// Shared shapes for the contracts workflow. Every adapter speaks these.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365" | "docusign";

export interface Settings {
  business_name?: string;
  owner_email: string;                                   // who gets the review note for each new contract
  microsoft_365: { mailbox: string; folder?: string; search?: string;
                   register?: { drive: string; item: string; table: string } };
  docusign?: { from_days?: number };                     // how far back to look for envelopes out for signature
  follow_up?: { after_days: number[] };                  // days after sending before each reminder to an unsigned signer
}

export interface Contract {
  id: string; title: string; from: { name?: string; email?: string }; received: string;
  attachments: { name: string; size: number }[];
  status: "new" | "in-review";
  ref: Record<string, string>;
}
export interface Signer { name: string; email: string; status: string; signedDateTime: string | null; routingOrder: string | null }
export interface Envelope { id: string; subject: string; status: string; sent: string | null; signers: Signer[]; reminders: string[] }

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const DAY = 864e5;
export const keyOf = (s: string) => safeKey(s, 90);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const daysSince = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / DAY;
export function ownerEmail(s: Settings): string {
  if (!EMAIL.test(s.owner_email ?? "")) throw new Error("owner_email is not set");
  return s.owner_email;
}
