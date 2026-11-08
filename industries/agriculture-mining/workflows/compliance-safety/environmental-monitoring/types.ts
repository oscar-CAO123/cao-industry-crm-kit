// Shared shapes for the environmental monitoring workflow. The register is the owner's own workbook table, written
// through Microsoft 365. Readings and lab results enter the local store from the owner's words or lab reports (see
// SKILL.md). Nothing here reads a monitoring platform.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365";

/** A limit from the licence, permit or site standard. Leave site or point empty to apply it everywhere. */
export interface Limit {
  parameter: string;   // as the licence names it, for example "pH" or "Turbidity"
  site?: string;
  point?: string;      // monitoring point, for example "DP1"
  min?: number;
  max?: number;
  unit?: string;
}

export interface Settings {
  business_name?: string;
  microsoft_365: {
    mailbox: string;                                            // the business's own mailbox, where drafts are created
    register: { drive: string; item: string; table: string };  // the workbook table the owner already keeps
    qc_email?: string;                                          // who receives the list of results that need a check
  };
  limits: Limit[];
}

export type Status = "new" | "registered" | "needs-check" | "checked";

export interface Reading {
  key: string;                 // safe store key, from id
  id: string;                  // the reading's own id, as entered (for example env-2026-11-08-dp1-ph)
  site: string;
  point: string;               // monitoring point, as the licence names it
  parameter: string;
  date: string;                // YYYY-MM-DD, the day the sample was taken
  value: number | string;      // as measured or as the lab reports it; text such as "<0.5" needs a check
  unit: string;
  source: string;              // "field meter" or the lab report reference
  note?: string;
  status: Status;
  missing?: string[];
  issue?: string;              // what a person must look at, once listed
  registered?: string;         // ISO time the register row was written or found
  checked?: string;            // ISO time the result passed its limit check
  flagged?: string;            // ISO time the result went onto a review list
}

export const ID = /^[A-Za-z0-9._-]{1,80}$/;
export const GRAPH_ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const keyOf = (s: string) => safeKey(s, 120);

/** The result as a number, or undefined for text such as "<0.5" or a blank. */
export function parsed(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = String(v ?? "").trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : undefined;
}

/** Fields a reading must carry before it counts as complete. */
export function missingFields(r: Reading): string[] {
  const out: string[] = [];
  for (const f of ["site", "point", "parameter", "unit", "source"] as const) if (!String(r[f] ?? "").trim()) out.push(f);
  if (!DATE.test(String(r.date ?? ""))) out.push("date");
  if (parsed(r.value) === undefined) out.push("value");
  return out;
}

/** The most specific limit for a result: a site and point match beats a site match, which beats a parameter match. */
export function limitFor(r: Reading, limits: Limit[]): Limit | undefined {
  const specificity = (l: Limit) => (l.site ? 1 : 0) + (l.point ? 1 : 0);
  return limits
    .filter((l) => l.parameter.toLowerCase() === r.parameter.toLowerCase()
      && (!l.site || l.site === r.site) && (!l.point || l.point === r.point))
    .sort((a, b) => specificity(b) - specificity(a))[0];
}

/** What a person must look at before a result counts as checked. An empty list means it passed. */
export function issues(r: Reading, limits: Limit[]): string[] {
  const missing = missingFields(r);
  if (missing.length) return [`missing ${missing.join(", ")}`];
  const l = limitFor(r, limits);
  if (!l) return ["no limit on file for this parameter"];
  if (l.unit && l.unit.toLowerCase() !== r.unit.toLowerCase()) return [`unit ${r.unit} differs from the limit's unit ${l.unit}`];
  const v = parsed(r.value) as number;
  const unit = l.unit ? ` ${l.unit}` : "";
  if (l.min !== undefined && v < l.min) return [`${v} ${r.unit} is below the minimum ${l.min}${unit}`];
  if (l.max !== undefined && v > l.max) return [`${v} ${r.unit} is above the maximum ${l.max}${unit}`];
  return [];
}

export const COLUMNS = ["Reading ID", "Date", "Site", "Monitoring point", "Parameter", "Value", "Unit", "Source", "Note", "Status"];

/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => {
  const s = String(v ?? "").slice(0, 300);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
};

/** One register row, in COLUMNS order. A value that reads as a number stays a number. */
export function rowFor(r: Reading): (string | number)[] {
  const missing = r.missing ?? [];
  const status = missing.length ? `Needs check: ${missing.join(", ")}` : "Registered";
  return [cell(r.id), cell(r.date), cell(r.site), cell(r.point), cell(r.parameter), parsed(r.value) ?? cell(r.value),
    cell(r.unit), cell(r.source), cell(r.note), cell(status)];
}

/** Escape text for the HTML of the review email. */
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
