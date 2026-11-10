// Shared shapes for the subcontractor compliance workflow. Two adapters speak these: Microsoft 365 (Outlook, and the
// Subcontractors register kept as an Excel table) and Dropbox (one folder per live job). Values from outside are checked here.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365" | "dropbox";

export interface Settings {
  business_name?: string;
  microsoft_365: {
    mailbox: string;                                           // the business's own mailbox
    folder?: string;                                           // Outlook folder for subcontractor replies (default inbox)
    search?: string;                                           // a word a reply must hold (default "certificate")
    register: { drive: string; item: string; table: string };  // the Subcontractors Excel table
  };
  dropbox?: { job_folders: string[] };                         // one Dropbox path per live job, for example /Jobs/12 Smith Street
  expiry_days?: number;                                        // chase a document this many days before it expires (default 30)
}

/** A register row, in column order. The business sets the table up with these headings. */
export const COLUMNS = ["Subcontractor", "Email", "Trade", "Document", "Expiry", "Status"] as const;
export interface Row { subcontractor: string; email: string; trade: string; document: string; expiry: string; status: string }

export const DAY = 864e5;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const DBX_PATH = /^\/[^\u0000]{1,500}$/;
/** A Dropbox job folder: absolute, and with no "." or ".." segment that the API would resolve to another folder. */
export const dbxPathOk = (p: string) => DBX_PATH.test(p) && !p.split("/").some((seg) => seg === "." || seg === "..");
export const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const keyOf = (s: string) => safeKey(s, 90);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);
/** Whole days from today to an ISO date (negative once it has passed). */
export const daysUntil = (iso: string, now: Date) => Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(day(now) + "T00:00:00Z")) / DAY);
/** Excel stores a typed date as a serial number of days since 1899-12-30, so a register read may return either form. */
export function expiryOf(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 2e6) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * DAY).toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  return ISO.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) ? s : "";
}
export function rowOf(v: unknown[]): Row {
  return {
    subcontractor: String(v[0] ?? "").slice(0, 120), email: String(v[1] ?? "").trim(), trade: String(v[2] ?? "").slice(0, 80),
    document: String(v[3] ?? "").slice(0, 120), expiry: expiryOf(v[4]), status: String(v[5] ?? "").slice(0, 40),
  };
}
