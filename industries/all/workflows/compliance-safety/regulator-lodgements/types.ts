// Shared shapes for the regulator-lodgements workflow. The adapter reads and drafts through Microsoft 365; the crons store and queue these.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365";

export interface Settings {
  family: "regulator-lodgement";
  business_name?: string;
  owner_email: string;                         // the person who signs off lodgements; internal drafts and reminders go here
  microsoft_365: {
    mailbox: string;                           // the mailbox regulators write to
    folder?: string;                           // default inbox
    search?: string;                           // a word every regulator notice carries, for example the regulator's name
    register: { drive: string; item: string; table: string };  // Excel table: Date | Key | Notice | From | Due | Status
  };
  notice_rules?: { match: string; due_days: number }[];        // the business sets each due window: the regulator docs give none
  reminder_days?: number;                      // remind when an open lodgement is due within this many days (default 7)
}

/** A regulator notice read from the mailbox. "registered" once its register row and owner draft exist. */
export interface Notice {
  id: string; title: string; from?: string; received: string; text?: string;
  ref?: Record<string, string>;
  status: "new" | "registered";
  due?: string;                                // YYYY-MM-DD, empty when no rule matched
  registered?: string;
}

export const day = (d: Date) => d.toISOString().slice(0, 10);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const keyOf = (s: string) => safeKey(s, 90);
