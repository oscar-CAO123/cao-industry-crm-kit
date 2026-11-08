// Shared shapes for the results-and-letters workflow. A result is one clinic result the practice has filed against a
// patient, with the reply letter to the GP that the agent has written from it. Patient content is health information:
// never log it, and keep it out of approval summaries and reasons.

export type Platform = "cliniko";

export interface Settings {
  business_name?: string;
  /** Cliniko treatment note template for the GP letter note. Numeric id as a string; optional. */
  default_template_id?: string;
  /** Cliniko recall type for the results-review recall. Numeric id as a string, set per practice. */
  result_review_recall_type_id?: string;
  /** Days after the result is filed before the results review is due. Defaults to 7. */
  review_after_days?: number;
}

export interface Result {
  id: string;
  patient_id: string;
  title: string;
  /** ISO date the result was filed against the patient. */
  filed: string;
  /** The GP letter, in plain text, written by the agent from the result. Only the clinician's words, no added findings. */
  letter?: string;
  status: "letter-ready" | "drafting" | "drafted" | "recall-queued" | "recall-set" | "needs-check";
  note_id?: string;
  reason?: string;
  created: string;
}
