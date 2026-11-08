// Shared shapes for the forms-typed-by-hand workflow. A form is read from its platform, its answers are checked against
// the fields the business needs, and a complete submission is handed to a person who enters it in the business's system.

export type Platform = "google-workspace";

export interface FieldSpec { question_id: string; label: string; required?: boolean }
export interface FormSpec { form_id: string; label: string; fields: FieldSpec[] }

export interface Settings {
  family: "matter-intake";
  business_name?: string;
  forms: FormSpec[];                 // which forms to read, and the fields each one must answer
  chase?: { after_days: number[] };  // days after the first chase before each follow-up (default 3 and 7)
}

export interface Submission {
  id: string;
  form_id: string;
  form: string;                      // the form's label, for the approval summary
  response_id: string;
  email?: string;                    // the respondent's address, when the form collects it
  received: string;
  seen: string;                      // last submitted time, so an edited response is picked up again
  answers: Record<string, string>;   // question id to answer text
  status: "new" | "chasing" | "ready" | "needs-contact";
  missing?: string[];                // labels of required fields still empty
  sheet?: [string, string][];        // label and value per field, once complete (values pass through cell())
  chased: string[];                  // when each chase was queued
  drafts: string[];                  // Gmail draft id per chase, so a re-run reuses the draft
}
