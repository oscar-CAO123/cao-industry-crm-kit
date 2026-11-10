// Shared shapes for the RFIs workflow. The agent skill writes question rows; the crons read and draft from them.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
export const idOr = (v: unknown) => (UUID.test(String(v ?? "")) ? String(v) : "");
export const ymd = (d: Date) => d.toISOString().slice(0, 10);

export interface Settings {
  business_name?: string;
  fieldwire?: {
    api_version: string;          // required date header, set from Fieldwire's versioning docs, never guessed
    projects: string[];           // project UUIDs to watch
    designer_user_id?: number;    // default assignee (the designer or builder's project manager) when a question names none
    default_due_days?: number;    // due date counted from the day the RFI is opened
  };
}

/** An RFI as Fieldwire holds it, kept so a later run can see what changed. */
export interface RfiRow {
  id: string; project: string; name: string; status: string; due: string; updated: string; seen: string;
}

/** A site question written by the agent skill into the "questions" collection. The draft cron acts on it. */
export interface QuestionRow {
  id: string; project: string; name: string; question: string;
  assignee_user_id?: number; due_date?: string; message?: string;
  status: "new" | "drafted" | "queued" | "needs-assignee" | "needs-person";
  rfi_id?: string; question_set?: boolean; reason?: string;
}
