// Shared shapes for the ask-your-data workflow. Figures come from the business's own accounts, Power BI and numbers pack;
// questions come from the owner's own address; every answer goes back to that address and waits for approval.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "xero" | "power-bi" | "microsoft-365";

export interface Settings {
  business_name?: string;
  owner_email: string;                       // the only sender whose questions are read, and the only recipient of answers
  microsoft_365: {
    mailbox: string;                         // the business mailbox that questions arrive in and drafts are made in
    folder?: string;                         // the folder questions arrive in (default inbox)
    numbers_pack?: { drive: string; item: string; table: string };   // an Excel table of label and value rows
  };
  xero?: { lookback_days?: number };         // present = read Xero reports and invoices
  power_bi?: { dataset_id: string; queries: Record<string, string> }; // fixed DAX the business agreed; never built from question text
}

/** One line of a figure set: a label and its value, both as text. */
export interface Figure { label: string; value: string }
export interface FigureSet { key: string; label: string; rows: Figure[]; error?: string }
export interface Snapshot { at: string; sets: Record<string, FigureSet> }

export interface Question {
  id: string; message_id: string; from: string; subject: string; text: string; received: string;
  status: "new" | "drafted" | "queued" | "skipped";
  draft_id?: string; approval?: string; reason?: string;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** Graph ids and workbook ids: letters, digits and a few safe marks only. */
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const DAY = 864e5;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const keyOf = (s: string) => safeKey(s, 90);
