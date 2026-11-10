// Shared shapes for the documents workflow. Google Workspace is the only platform with mapped support for this job.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "google-workspace";

export interface Settings {
  business_name?: string;
  google: {
    spreadsheet_id: string;                                   // the records tab and the document log live in this sheet
    records: {
      range: string;                                          // for example "Records!A1:Z500"; row 1 is the header row
      ready_value?: string;                                   // the status that marks a record ready (default "ready")
      columns: { id: string; kind: string; email: string; status: string };  // header names of those four columns
    };
    log_range: string;                                        // for example "Document log!A1": one row per document
    output_folder_id: string;                                 // the Drive folder finished drafts are made in
  };
  documents: { kind: string; template_id: string; fields: string[] }[];  // one Google Doc template per kind; fields = the record columns its {{placeholders}} use
  share_role?: "reader" | "commenter";                        // the role given to the client on approval (default reader)
}

export type Status = "new" | "copied" | "drafted" | "needs-person" | "held" | "queued";

export interface Request {
  id: string; kind: string; email?: string; fields: Record<string, string>; received: string;
  status: Status; doc_id?: string; url?: string; reason?: string; approval?: string;
}

export const ID = /^[A-Za-z0-9_-]{1,120}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const HEADER = /^[A-Za-z][A-Za-z0-9 _-]{0,59}$/;
export const keyOf = (s: string) => safeKey(s, 90);
/** The store key for a record. Every cron finds a request by it. */
export const requestKey = (id: string) => keyOf(`record:${id}`);
/** One line of text from outside the business: no line breaks, no runs of spaces, capped in length. */
export const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
