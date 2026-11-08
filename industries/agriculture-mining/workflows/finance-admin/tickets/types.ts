// Shared shapes for the delivery tickets workflow. Only Microsoft 365 is mapped for this job.
export type { Platform } from "../../../../construction/workflows/sales/quoting/types.ts";
export { cell, EMAIL, esc, day } from "../../../../construction/workflows/sales/quoting/types.ts";

export interface Table { drive: string; item: string; table: string }

export interface Settings {
  business_name?: string;
  microsoft_365: {
    mailbox: string;          // the ticket mailbox (the client's own)
    folder?: string;          // mail folder to read, default inbox
    search?: string;          // subject or body word that marks a docket email, default docket
    tickets: Table;           // the register: one row per delivery ticket
    qc?: Table;               // the QC log: one row per ticket whose grade is wrong
    qc_contact: string;       // the QC group's email address
  };
  expected_grades: Record<string, string>; // spec as written on the docket -> the grade the contract pays for
}

/** One delivery ticket. Written by intake from a mail message, then completed by a person in the shell. */
export interface Ticket {
  key: string;
  source: "mail" | "shell";
  message_id?: string;
  title?: string;
  received?: string;
  docket_no?: string;
  date?: string;             // YYYY-MM-DD
  carrier?: string;
  supplier?: string;
  site?: string;
  spec?: string;
  grade?: string;
  net_tonnes?: number;
  status: "new" | "recorded" | "flagged" | "cleared" | "held";
  reason?: string;
  approval?: string;         // approval id, once the QC email is queued
}

export const DOCKET = /^[A-Za-z0-9][A-Za-z0-9/-]{0,39}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const GRAPH_ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const text = (v: unknown, max = 120) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
export const grade = (v: unknown) => String(v ?? "").trim().toLowerCase();
export const hasSpec = (expected: Record<string, string>, spec: string) => Object.prototype.hasOwnProperty.call(expected, spec);

/** Why a ticket cannot be recorded, or null when it can. Checks every field before it reaches a row. */
export function problem(t: Ticket, expected: Record<string, string>): string | null {
  if (!t.docket_no || !DOCKET.test(String(t.docket_no))) return "docket number is missing or not valid";
  if (!t.date || !DATE.test(String(t.date))) return "docket date is missing or not a date";
  if (!text(t.carrier) || !text(t.supplier) || !text(t.site)) return "carrier, supplier or site is missing";
  if (!t.spec || !hasSpec(expected, String(t.spec))) return `spec ${t.spec ?? "(none)"} is not in expected_grades`;
  if (!text(t.grade)) return "grade is missing";
  if (!(typeof t.net_tonnes === "number" && Number.isFinite(t.net_tonnes) && t.net_tonnes > 0 && t.net_tonnes < 100000)) return "net tonnes is not a positive number";
  return null;
}
