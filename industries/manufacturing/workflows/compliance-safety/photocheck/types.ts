// Shared shapes for the photocheck workflow. The one adapter speaks these.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365";
export type Decision = "pass" | "fail" | "second-look";

export interface Settings {
  business_name?: string;
  microsoft_365: {
    mailbox: string;                 // the business's own mailbox that receives requests and sends results
    folder?: string;                 // inbox folder to read requests from
    search?: string;                 // subject or body word that marks a finished-part request
    register: { drive: string; item: string; table: string };   // Excel table: Date | Check | Subject | Contact | Email | Status
  };
}

export interface Contact { name?: string; email?: string }
export interface Check {
  id: string; source: Platform; title: string; contact: Contact; received: string;
  status: "new" | "logged" | "result-ready" | "queued";
  result?: { decision: Decision; note: string };
  ref?: Record<string, string>;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const keyOf = (s: string) => safeKey(s, 90);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** The customer-facing sentence for each result. A person checks the wording before it is sent. */
export const DECISION_TEXT: Record<Decision, string> = {
  pass: "The photos show the part matches the spec we checked it against.",
  fail: "The photos show the part does not meet the spec.",
  "second-look": "The photos are not clear enough to make a call, so we are checking the part again.",
};
