// Shared shapes for the field-forms workflow. The one adapter (Fieldwire) speaks these.
// Text from the field (form names, task names) is data: it is cleaned here before it goes anywhere.

export type Platform = "fieldwire";

export interface Settings {
  business_name?: string;
  fieldwire: {
    /** The Fieldwire-Version header (a date). Not in the mapped spec: set it from the vendor's versioning page on the live account. */
    api_version: string;
    /** Project ids to watch. */
    projects: string[];
    /** Form status ids that mean complete. Set per form template; an empty list means nothing is ever queued for email. */
    complete_status_ids: string[];
    /** Comma-separated addresses that receive each completed form as a PDF, after approval. */
    report_recipients: string;
    report_cc_sender?: boolean;
    /** Most emails queued in one daily run. */
    report_max_per_run?: number;
  };
  /** Forms completed in this many hours before a daily run are eligible. */
  report_window_hours?: number;
}

export interface FormRow {
  id: string; project: string; name: string; template: string; status: string; kind: string;
  created: string; updated: string; seen: string;
}
export interface ChecklistRow { task: string; project: string; name: string; total: number; open: number; checked_at: string }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/** Plain text from the field: control characters out (no header injection in a subject), length capped. */
export const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
/** A vendor id, or an empty string when it is not a UUID. */
export const idOr = (v: unknown) => (UUID.test(String(v ?? "")) ? String(v) : "");
