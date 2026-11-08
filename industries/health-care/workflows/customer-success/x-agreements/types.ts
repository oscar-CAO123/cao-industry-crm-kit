// Shared shapes for the service agreements workflow.

export interface Settings {
  business_name?: string;
  cliniko: { agreement_template_id: string };   // the patient form template that is the agreement
  expire_after_days?: number;                    // unsigned after this many days: expiry queued (default 21)
  cases_per_run?: number;                        // active patient cases read per intake run (default 100, max 100)
}

export interface Agreement {
  key: string; patient_id: string; template_id: string; form_id: string; created: string;
  expiry_queued?: string; filed?: string;
}

/** Cliniko ids are digit strings. Checked before any id goes into a path, a filter or a store key. */
export const ID = /^\d{1,20}$/;
export function id(v: unknown, what: string): string {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  if (!ID.test(s)) throw new Error(`${what}: not a Cliniko id`);
  return s;
}

export const DAY = 864e5;
