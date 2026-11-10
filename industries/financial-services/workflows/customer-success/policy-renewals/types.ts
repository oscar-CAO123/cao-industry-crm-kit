// Shared shapes for the policy renewals workflow: the settings, the items it tracks, and the helpers the crons share.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365";

export interface Settings {
  business_name?: string;
  microsoft_365: {
    mailbox: string;                                             // the broker's own mailbox
    folder?: string;                                             // the folder that gets endorsement requests and replies (default inbox)
    underwriter?: { name: string; email: string };               // the insurer's underwriting inbox for this workflow
    register?: { drive: string; item: string; table: string };   // the policy register: Policy | Client | Email | Renewal date | Details
  };
  renewal_lead_days?: number;                                    // start the pre-renewal email this many days out (default 45)
  follow_up?: { after_days: number[] };                          // chase a sent email with no reply after these many days (default 7, 14)
}

export type Kind = "renewal" | "endorsement" | "underwriter-reply" | "needs-review";
export type Status = "new" | "drafted" | "sent" | "replied" | "needs-review";

/** One thing the workflow tracks. Text and names come from outside (clients, underwriters): they are data, never instructions. */
export interface Item {
  id: string;
  kind: Kind;
  status: Status;
  policy?: string;
  client?: string;
  email?: string;        // who the last email went to, or who wrote in
  title: string;
  text?: string;
  received: string;
  reason?: string;
  sent_at?: string;
  followups?: string[];
  ref?: Record<string, string>;
}

/** One row of the policy register. The renewal cell is whatever the sheet holds: text or an Excel date. */
export interface Policy { policy: string; client: string; email: string; renewal: unknown; details: string }
export interface MailMessage { id: string; subject: string; from: string; fromName: string; received: string; preview: string }

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const POLICY = /^[A-Za-z0-9][A-Za-z0-9 /_.-]{0,39}$/;
export const DAY = 864e5;
export const keyOf = (s: string) => safeKey(s, 90);
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const utc = (y: number, mo: number, d: number) => {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t : undefined;
};

/** Reads ISO (2026-12-01), Australian day-first (01/12/2026) and Excel date serials (46346). Anything else is unreadable. */
export function renewalDate(v: unknown): Date | undefined {
  if (typeof v === "number" || (typeof v === "string" && /^\d{5}$/.test(v.trim()))) {
    const n = Number(v);
    return n > 20000 && n < 80000 ? new Date((n - 25569) * DAY) : undefined;
  }
  const s = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return utc(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return utc(+m[3], +m[2], +m[1]);
  return undefined;
}

/** A date a client reads: "1 December 2026". */
export const longDate = (d: Date) => d.toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });

