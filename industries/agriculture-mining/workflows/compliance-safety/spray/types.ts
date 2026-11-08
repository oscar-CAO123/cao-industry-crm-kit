// Shared shapes for the spray and harvest records workflow. The register's columns are the owner's own workbook
// table, written through Microsoft 365 (the platform the one call names). Records enter the local store from the
// owner's words or paper dockets (see SKILL.md); nothing here reads a spray or grain platform.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365";
export type RecordKind = "spray" | "harvest" | "receival";

export interface Settings {
  business_name?: string;
  microsoft_365: {
    mailbox: string;                                              // the business's own mailbox, where drafts are created
    register: { drive: string; item: string; table: string };    // the workbook table the owner already keeps
    qc_email?: string;                                            // who receives the list of records that need a check
  };
}

export interface SprayRecord {
  key: string;                 // safe store key, from id
  id: string;                  // the record's own id, as entered (for example spray-2026-11-09-1)
  kind: RecordKind;
  date: string;                // YYYY-MM-DD
  field: string;               // paddock or field name, as the owner says it
  product?: string;            // spray product, as entered
  rate?: string;               // label rate with units, as entered
  weather?: string;            // wind, temperature and humidity at application
  withholding_until?: string;  // date the withholding period ends, as entered
  operator?: string;
  load_ref?: string;           // docket or load number, for harvest and receival
  grade?: string;              // grade on the docket
  note?: string;
  status: "new" | "registered" | "needs-check";
  missing?: string[];
  registered?: string;         // ISO time the register row was written or found
  flagged?: string;            // ISO time the record went onto a QC list
}

export const ID = /^[A-Za-z0-9._-]{1,80}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const MSG_ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const keyOf = (s: string) => safeKey(s, 120);

/** The fields a record must carry before it counts as complete. */
export const REQUIRED: Record<RecordKind, (keyof SprayRecord)[]> = {
  spray: ["date", "field", "product", "rate", "weather", "operator", "withholding_until"],
  harvest: ["date", "field", "load_ref", "grade"],
  receival: ["date", "field", "load_ref", "grade"],
};

export function missingFields(r: SprayRecord): string[] {
  if (!Object.hasOwn(REQUIRED, r.kind)) return ["kind"];
  const out: string[] = [];
  if (!DATE.test(String(r.date ?? ""))) out.push("date");
  for (const f of REQUIRED[r.kind]) {
    if (f === "date") continue;
    if (!String(r[f] ?? "").trim()) out.push(String(f));
  }
  return out;
}

export const COLUMNS = ["Record ID", "Date", "Kind", "Field", "Product", "Rate", "Weather", "Withholding until", "Operator", "Load ref", "Grade", "Status"];

/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => {
  const s = String(v ?? "").slice(0, 300);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
};

/** One register row, in COLUMNS order. */
export function rowFor(r: SprayRecord): string[] {
  const missing = r.missing ?? [];
  const status = missing.length ? `Needs check: ${missing.join(", ")}` : "Complete";
  return [r.id, r.date, r.kind, r.field, r.product, r.rate, r.weather, r.withholding_until, r.operator, r.load_ref, r.grade, status]
    .map((v) => cell(v));
}

/** Escape text for the HTML of the QC email. */
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
