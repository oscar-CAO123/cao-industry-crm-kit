// Shared shapes for the labour-by-person workflow. ServiceM8 clock events become each person's hours on a Xero Payroll AU
// draft timesheet. Approving a timesheet changes what gets paid, so it is only ever queued for a person.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface Settings {
  business_name?: string;
  /** The pay period to run, set by the owner each cycle. Dates are YYYY-MM-DD. */
  pay_period: { start: string; end: string; payment_date: string };
  /** The Xero Payroll AU calendar for this pay period (PayrollCalendarID, a GUID). */
  payroll_calendar_id: string;
  /** ServiceM8 staff uuid to Xero employeeID (a GUID). Staff with no entry are skipped and counted. */
  employee_map: Record<string, string>;
  /** The Xero earnings rate (a GUID) for ordinary hours. Every line uses it. */
  earnings_rate_id: string;
  /** One shift above this many hours is held for a person. Defaults to 12. */
  max_hours_per_shift?: number;
}

/** One complete shift: a clock-on paired with its clock-off, less lunch. key is the clock-on event's uuid. */
export interface Shift { key: string; staff: string; date: string; hours: number }

/** What the store keeps for each shift: mirrored into Xero, held for a person, or needing a check. */
export interface ShiftRec {
  state: "creating" | "mirrored" | "flagged" | "needs-check";
  period: string; staff: string; date: string; hours: number;
  xero_timesheet?: string; reason?: string; at: string;
}

/** The Xero employees held from approval for one pay period. Each mirror run rewrites it. */
export interface Holds { employees: string[]; at: string }

/** A Xero timesheet as the crons read it. */
export interface XeroTimesheet { timesheetID: string; employeeID: string; status: "Draft" | "Approved" | "Completed"; totalHours: number }

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A vendor id must be a GUID. Anything else is refused before it is written anywhere. */
export const guid = (v: unknown, what: string): string => {
  const s = String(v ?? "");
  if (!GUID.test(s)) throw new Error(`${what}: bad id`);
  return s;
};

/** Plain text from outside: no control characters, trimmed, capped. */
export const clean = (s: unknown, max = 255) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

/** A safe store and idempotency key from a few parts. */
export const keyFor = (...parts: string[]) => safeKey(parts.join(":"), 120);

/** The day after a YYYY-MM-DD date. */
export const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

/** The pay period, checked: real dates, start on or before end, and a Xero calendar id. Throws on a bad setting. */
export function period(s: Settings): { start: string; end: string } {
  const p = s.pay_period;
  if (!p || !DAY.test(p.start) || !DAY.test(p.end) || !DAY.test(p.payment_date)) throw new Error("pay_period needs start, end and payment_date as YYYY-MM-DD");
  if (!(Date.parse(p.start) <= Date.parse(p.end))) throw new Error("pay_period start is after end");
  guid(s.payroll_calendar_id, "payroll_calendar_id");
  return { start: p.start, end: p.end };
}
