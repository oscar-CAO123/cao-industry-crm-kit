// Shared shapes for the rostering workflow. The adapter speaks these; the crons only use these.
export type Platform = "deputy";

/** One block of demand: how many people the business needs for a window of time. Times carry their offset. */
export interface Demand { date: string; start: string; end: string; headcount: number }

export interface Settings {
  business_name?: string;
  deputy: {
    operational_unit: number;        // the Deputy location or department the roster is built for
    draft_days_ahead?: number;       // how far ahead demand is drafted (default 14)
    publish_days_ahead?: number;     // how far ahead drafts are queued for publishing (default 7)
    late_grace_minutes?: number;     // a clock-in this many minutes after the rostered start is flagged (default 5)
  };
  demand: Demand[];
}

/** A shift the kit drafted or saw in Deputy. Only what the crons need. */
export interface Shift { id: string; employee: number; employee_name?: string; date: string; start: number; end: number; published: boolean }
/** A demand block that could not be filled, with the reason a person can act on. */
export interface Shortfall { demand: string; wanted: number; drafted: number; reason: string; noted: string }
/** A clock-in or timesheet that needs a person to look at it. */
export interface Flag { timesheet: number; employee: number; reason: string; noted: string }

export const DAY = 864e5;
export const int = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`rostering: bad ${what}`);
  return n;
};
/** Deputy stores times as whole seconds. Inputs may be ISO strings (with offset) or seconds already. */
export const seconds = (v: unknown): number => typeof v === "number" ? v : Math.floor(Date.parse(String(v)) / 1000);
export const demandKey = (d: Demand) => `${d.date}-${seconds(d.start)}-${seconds(d.end)}`;
export const hhmm = (sec: number) => new Date(sec * 1000).toISOString().slice(11, 16);
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;
export const label = (s: string) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, 120);
