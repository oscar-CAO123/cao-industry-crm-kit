// Shared shapes for the care plan workflow. The only platform is Cliniko (the practice system that holds the patient,
// the referral and the care plan note).

export interface Settings {
  business_name?: string;
  care_plan_template_id: string;    // Cliniko treatment note template used for the care plan draft
  intake_form_template_id: string;  // Cliniko patient form template for the intake assessment
  lookback_days?: number;           // how far back the intake cron looks for new patients (default 14)
}

export interface Enquiry {
  id: string;                       // "cliniko:<patient id>"
  patient_id: string;
  created: string;
  referral: string | null;          // the referral source type's name, or null when Cliniko holds none
  status: "new" | "drafted";
  note_id?: string;                 // the draft treatment note, once created (so a re-run never makes a second one)
}

/** Cliniko ids are numeric strings. Anything else is refused before it reaches a path or a body. */
export const numericId = (v: unknown): string => {
  const s = String(v ?? "");
  if (!/^\d{1,20}$/.test(s)) throw new Error("cliniko: bad id");
  return s;
};
