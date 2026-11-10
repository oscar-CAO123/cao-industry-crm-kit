// Shared shapes for the expiry-alerts workflow. The register is one Excel table with four columns: Holder | Email | Item | Expiry.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface Settings {
  business_name?: string;
  microsoft_365: { mailbox: string; register: { drive: string; item: string; table: string } };
  owner_email?: string;
  remind_within_days?: number;   // default 30: a holder is emailed once an item is this close to expiry, or after it lapses
  digest_within_days?: number;   // default 90: the owner's weekly digest lists items this close
}

export interface RegisterRow {
  key: string; holder: string; email?: string; item: string; expiry?: string; days_left?: number;
  status: "expired" | "due" | "ok" | "unknown";
}
export interface Reminder { key: string; item_key: string; holder: string; expiry: string; draft_message: string; approval: string; drafted: string }

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const keyOf = (s: string) => safeKey(s, 90);

const DAY = 864e5;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** A calendar date as epoch ms, or undefined when the day does not exist (31/02 is refused). */
const ymd = (y: number, mo: number, d: number): number | undefined => {
  const t = Date.UTC(y, mo - 1, d), x = new Date(t);
  return x.getUTCFullYear() === y && x.getUTCMonth() === mo - 1 && x.getUTCDate() === d ? t : undefined;
};

/** A register cell as a calendar date (YYYY-MM-DD): an ISO date, an Australian d/m/yyyy date, or an Excel date serial. */
export function parseExpiry(v: unknown): string | undefined {
  let t: number | undefined;
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 20000 && v < 80000) t = EXCEL_EPOCH + Math.round(v) * DAY;
  } else if (typeof v === "string") {
    const s = v.trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s), au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (iso) t = ymd(+iso[1], +iso[2], +iso[3]);
    else if (au) t = ymd(+au[3], +au[2], +au[1]);
  }
  if (t === undefined) return undefined;
  const y = new Date(t).getUTCFullYear();
  return y >= 2000 && y <= 2100 ? new Date(t).toISOString().slice(0, 10) : undefined;
}

/** Whole days from today (UTC date) to an expiry date; negative once it has lapsed. */
export function daysLeft(now: Date, expiry: string): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(expiry) - today) / DAY);
}
