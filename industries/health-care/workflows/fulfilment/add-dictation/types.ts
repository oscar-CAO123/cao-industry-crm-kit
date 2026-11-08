// Shared shapes for the add-dictation workflow. A session is one clinical visit whose spoken or transcribed notes
// are to become a treatment note in the practice's own system (Cliniko). Patient content is health information:
// never log it, and keep it out of approval summaries.

export type Platform = "cliniko";

export interface Settings {
  business_name?: string;
  /** Cliniko treatment note template to use when a session names none. Set per practice; numeric id as a string. */
  default_template_id?: string;
}

export interface Question { name: string; answer: string; type?: "text" }
export interface Section { name: string; description?: string; questions: Question[] }

export interface Session {
  id: string;
  title: string;
  patient_id: string;
  attendee_id?: string;
  booking_id?: string;
  template_id?: string;
  /** The note, already split into the template's sections and questions. Answers are plain text; the adapter escapes them. */
  sections: Section[];
  status: "transcript-ready" | "drafting" | "drafted" | "reviewed" | "sign-queued" | "signed" | "needs-check";
  note_id?: string;
  reason?: string;
  created: string;
}
