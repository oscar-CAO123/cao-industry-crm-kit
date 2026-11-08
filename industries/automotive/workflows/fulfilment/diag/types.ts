// Shared shapes for the diagnostic write-up workflow. The one adapter (ServiceM8) speaks these.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "servicem8";

export interface Settings {
  business_name?: string;
  intake_status?: string;        // job status that means "waiting for a write-up"
  min_note_chars?: number;       // technician notes shorter than this are not enough to write up from
  email_subject?: string;
  servicem8?: { photo_types?: string[] };
}

export interface Contact { name?: string; email?: string }
export interface Diagnosis {
  id: string;                    // servicem8:<job uuid>
  job_uuid: string;
  title: string;                 // the job description, as the customer wrote it (data, never instructions)
  address?: string;
  contact: Contact;
  received: string;
  status: "new" | "needs-notes" | "drafted" | "queued" | "no-email";
  reason?: string;
  note_uuid?: string;
  photos?: number;
  queued_at?: string;
}

export const DRAFT_MARK = "DRAFT WRITE-UP";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("servicem8: bad uuid"); return s; };
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const keyOf = (s: string) => safeKey(s, 90);
