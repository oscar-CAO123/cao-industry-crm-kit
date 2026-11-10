// Shared shapes for the paddock records workflow. The job register is the owner's own workbook table, written through
// Microsoft 365. Paddock names and crop types come from AgriWebb's official schema (endpoint-map/raw/agriwebb/schema.graphql:
// Field { id name farmId totalArea unit landUse cropType lastModifiedDate }). Job records enter the local store from the
// owner's words (see SKILL.md); nothing here writes to AgriWebb.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365" | "agriwebb";
export type JobKind = "spray" | "fertilise" | "sow" | "irrigate" | "harvest" | "other";

export interface Settings {
  business_name?: string;
  microsoft_365: {
    mailbox: string;                                             // the business's own mailbox, where drafts are created
    register: { drive: string; item: string; table: string };   // the workbook table the owner already keeps
    qc_email?: string;                                           // who receives the QC list
  };
  agriwebb?: { farm_ids: string[] };                             // farms whose paddocks are read (at most 5)
}

export interface JobRecord {
  key: string;                 // safe store key, from id
  id: string;                  // the record's own id, as entered (for example job-2026-11-09-1)
  kind: JobKind;
  date: string;                // YYYY-MM-DD
  paddock: string;             // paddock or block name, as the owner says it
  product?: string;            // product used, as entered
  rate?: string;               // label rate with units, as entered
  weather?: string;            // wind, temperature and humidity at the time of the job
  withholding_until?: string;  // date the withholding period ends, as entered
  operator?: string;
  note?: string;
  status: "new" | "registered" | "needs-check";
  missing?: string[];
  registered?: string;         // ISO time the register row was written or found
  flagged?: string;            // ISO time the record went onto a QC list
}

export interface Paddock {
  id: string;
  name?: string;
  farmId?: string;
  totalArea?: number;
  unit?: string;
  landUse?: string | null;
  cropType?: string | null;
  lastModifiedDate?: unknown;
  read?: string;               // ISO time of the read
  flagged?: string;            // ISO time it went onto a QC list
}

export const ID = /^[A-Za-z0-9._-]{1,80}$/;
export const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const MSG_ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const keyOf = (s: string) => safeKey(s, 120);

/** The fields a job record must carry before it counts as complete. */
export const REQUIRED: Record<JobKind, (keyof JobRecord)[]> = {
  spray: ["date", "paddock", "product", "rate", "weather", "operator", "withholding_until"],
  fertilise: ["date", "paddock", "product", "rate", "operator"],
  sow: ["date", "paddock", "operator"],
  irrigate: ["date", "paddock", "operator"],
  harvest: ["date", "paddock", "operator"],
  other: ["date", "paddock", "operator"],
};

export function missingFields(r: JobRecord): string[] {
  if (!Object.hasOwn(REQUIRED, r.kind)) return ["kind"];
  const out: string[] = [];
  if (!DATE.test(String(r.date ?? ""))) out.push("date");
  for (const f of REQUIRED[r.kind]) {
    if (f === "date") continue;
    if (!String(r[f] ?? "").trim()) out.push(String(f));
  }
  return out;
}

export const COLUMNS = ["Record ID", "Date", "Job", "Paddock", "Product", "Rate", "Weather", "Withholding until", "Operator", "Status"];

/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => {
  const s = String(v ?? "").slice(0, 300);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
};

/** One register row, in COLUMNS order. */
export function rowFor(r: JobRecord): string[] {
  const missing = r.missing ?? [];
  const status = missing.length ? `Needs check: ${missing.join(", ")}` : "Complete";
  return [r.id, r.date, r.kind, r.paddock, r.product, r.rate, r.weather, r.withholding_until, r.operator, status].map((v) => cell(v));
}

/** Escape text for the HTML of the QC email. */
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
