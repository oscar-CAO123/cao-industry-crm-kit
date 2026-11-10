// Shared shapes for the shift note workflow. The adapter speaks these; the crons work only on these.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "deputy";

export interface Check { label: string; any: string[] }
export interface Settings {
  family: "shift-note";
  business_name?: string;
  lookback_days?: number;   // how many days of timesheets the collect cron reads
  min_words?: number;       // a note shorter than this is flagged
  checks: Check[];          // the points a note must cover; each needs one of its words
}

export interface ShiftNote {
  key: string;              // one per timesheet
  platform: Platform;
  timesheet_id: number;
  date: string;
  note: string;
  status: "new" | "ok" | "flagged";
  gaps?: string[];
  created: string;
  reviewed_at?: string;
}

/** The text of a timesheet's shift note: the field the vendor spec names EmployeeComment. */
export interface TimesheetRow { Id?: unknown; Date?: string; EmployeeComment?: string }

/** Only a positive whole number may become a path segment. */
export const timesheetId = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};
export const keyOf = (id: number) => safeKey(`shiftnote.deputy.${id}`, 90);

/** Pure check: which of the required points a note misses. Keyword matching only; a person still reads the note. */
export function checkNote(note: string, s: Settings): string[] {
  const text = note.trim();
  const gaps: string[] = [];
  const words = text ? text.split(/\s+/).length : 0;
  if (words < (s.min_words ?? 8)) gaps.push(`too short (${words} words)`);
  const lower = text.toLowerCase();
  for (const c of s.checks) {
    if (!c.any.some((w) => lower.includes(w.toLowerCase()))) gaps.push(c.label);
  }
  return gaps;
}

/** The review comment left on a timesheet. Plain text; the note itself is never repeated in it. */
export const reviewText = (gaps: string[]) =>
  `Shift note check (automatic, for the supervisor): this note may be missing: ${gaps.join("; ")}. Please read it and follow up with the worker.`;
