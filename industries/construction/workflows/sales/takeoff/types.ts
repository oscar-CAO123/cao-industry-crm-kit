// Shared shapes for the tender reader. Crons read, log and draft; the one live act (sending the digest) is only queued.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365" | "bluebeam";

export interface Table { drive: string; item: string; table: string }

export interface Settings {
  family: "tender-takeoff";
  business_name?: string;
  microsoft_365: { mailbox: string; folder?: string; search?: string; digest_to: string; register: Table; takeoff: Table };
  bluebeam: { project_id: string; max_polls?: number };
}

export interface TenderRef {
  message_id: string;
  tender_ref?: string;     // the tender number read from the subject line
  plan_file_id?: string;   // Bluebeam file id, once matched
  markup_job_id?: string;  // Bluebeam markup list job, once started
  markup_polls?: number;   // how many times the result has been read without rows
}

export interface Tender {
  id: string;
  title: string;
  sender?: string;
  received: string;
  ref: TenderRef;
  status: "logged" | "markup-running" | "takeoff-drafted" | "needs-check";
  updated: string;
}

export interface NoticeIn { id: string; title: string; text: string; sender?: string; received: string }
export interface PlanFile { Id: number; Name: string }
export interface MarkupRow { page: number; type: string; subject: string; comment: string; author?: string; created?: string }

export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PROJECT = /^[A-Za-z0-9-]{1,80}$/;
export const MAX_ROWS = 500;
export const keyOf = (s: string) => safeKey(s, 90);
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const tableIds = (t: Table) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};
/** The tender number in a subject such as "Tender 4471: fencing package". Starts with a digit, so "Tender for ..." gives nothing. */
export const tenderRef = (s: string) => /tender\s*(?:no\.?|number|#)?\s*(\d[A-Za-z0-9-]{1,29})/i.exec(s)?.[1];
export const day = (d: Date) => d.toISOString().slice(0, 10);
