// Shared shapes for the patient support desk. Every adapter speaks these, so a step can point at any platform.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface Settings {
  family: "all";
  business_name: string;
  support: "zendesk";              // where enquiries arrive
  records: "cliniko" | "none";     // where the patient record lives; read only, to match an enquirer
  turnaround?: string;             // what the holding reply promises, e.g. "the next business day"
  reply_after_days?: number[];     // chase a reply still pending the enquirer, this many days after it was approved
  clinical_words?: string[];       // added to the built-in list: any match escalates to a clinician, no automatic reply
  signature?: string;              // the sign-off on every reply
}

export interface Contact { name?: string; email?: string }
export interface Enquiry {
  id: string;                      // "zendesk:<ticket id>"
  ticket: number;
  title: string;
  text: string;
  contact: Contact;
  received: string;
  patient?: { id: string; matched_by: "email" | "name" };   // the record id only: no clinical data is kept
  status: "new" | "clinician" | "queued" | "replied" | "needs-staff" | "closed";
  reason?: string;
  reply_key?: string;
  replied_at?: string;
  followups?: string[];
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** Plain text from outside: control characters out, capped in length. */
export const cap = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
export const keyOf = (s: string) => safeKey(s, 90);

/** Words that mean a clinician answers. This is a safety net, not triage: a person still reads every reply. */
export const CLINICAL = ["pain", "injur", "symptom", "medic", "surgery", "post-op", "bleed", "emergency", "chest", "breath",
  "fall", "fell", "accident", "dizz", "numb", "pregnan", "diagnos", "scan", "result", "hurt", "swell", "lump", "infect", "allerg"];
export function clinicalHits(s: { clinical_words?: string[] }, text: string): string[] {
  const t = text.toLowerCase();
  const words = [...new Set([...CLINICAL, ...(s.clinical_words ?? []).map((w) => String(w).toLowerCase())])];
  return words.filter((w) => w && t.includes(w));
}
