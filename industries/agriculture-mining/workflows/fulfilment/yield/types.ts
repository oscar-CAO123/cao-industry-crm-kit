// Shared shapes for the yield-and-waste workflow. The yield register is an Excel table the shed keeps in its own
// Microsoft 365 workbook: Date | Lot | Area | Gross kg | Packed kg | Waste kg. The crons read it, write exception rows to a
// second table, and draft the owner's weekly report. Nothing here sends.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface Table { drive: string; item: string; table: string }

export interface Settings {
  business_name?: string;
  owner_email: string;                                   // who gets the weekly report, once a person approves it
  microsoft_365: { mailbox: string; register: Table; exceptions?: Table };
  expected_yield_pct: number;                            // packed kg over gross kg, per lot
  waste_alert_pct: number;                               // waste kg over gross kg, per lot
}

export interface Lot { lot: string; date: string; area: string; gross_kg: number; packed_kg: number; waste_kg: number; seen: string }
export interface Exception { lot: string; date: string; yield_pct: number; waste_pct: number; reasons: string[]; raised: string }
export interface Report {
  week: string; lots: number; gross_kg: number; packed_kg: number; waste_kg: number;
  yield_pct: number; waste_pct: number; shortfall: string[]; html: string; message_id?: string; queued?: string;
}

/** Workbook, drive and message ids: letters, digits and a few symbols, never a path or a URL. */
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
/** A lot code as the shed writes it. */
export const LOT = /^[A-Za-z0-9][A-Za-z0-9 _/.\-]{0,59}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const keyOf = (s: string) => safeKey(s, 90);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
/** A percentage to one decimal place; zero when there is nothing to divide by. */
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
/** A number from a cell, or NaN when the cell is blank or not a number. */
export const num = (v: unknown) => {
  if (typeof v === "number") return v;
  const s = String(v ?? "").replace(/,/g, "").trim();
  return s === "" ? NaN : Number(s);
};
/** The Monday of the week that holds d, as YYYY-MM-DD (UTC). */
export const weekStart = (d: Date) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};
