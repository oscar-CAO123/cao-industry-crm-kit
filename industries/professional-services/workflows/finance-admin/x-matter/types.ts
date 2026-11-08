// Shared shapes for the email-to-matter workflow. Smokeball is the only platform mapped for this job.
export type Platform = "smokeball";

export interface Settings {
  business_name?: string;
  lead_matter_type_id?: string;   // empty: an unknown sender waits for a person; set: a lead matter is opened for them
  reply_due_days?: number;        // the follow-up task's due date, in days from when the note is filed (default 2, 1 to 30)
}

/** An email a person or the Outlook add-in records in the workflow store (collection "emails"). Its id is set by the recorder. */
export interface Email {
  id: string; from: string; name?: string; subject: string; text?: string; received: string;
  status: "new" | "matched" | "needs-person" | "filed";
  reason?: string;
  contact_id?: string; matter_id?: string; lead?: boolean;
  context?: { title: string; created: string | null; plain: string }[];   // the matter's recent notes, read before the note is filed
  memo_id?: string; task_id?: string;
  reply?: string;                 // the reply text, written by a person or the agent skill after reading the context
  reply_approval?: string;        // the approval id once the reply is queued
}
