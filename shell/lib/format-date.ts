import { format } from "date-fns";

/**
 * Formats a date the way the tables did with moment: a missing or invalid date reads "Invalid date" instead of
 * throwing. The pattern is a date-fns pattern (yyyy, dd, MMM, HH:mm).
 */
export function formatDatePattern(value: unknown, pattern: string): string {
  if (value === null || value === undefined || value === "") return "Invalid date";
  // A bare date ("2026-01-02") is a calendar day in the viewer's own zone, as moment read it; new Date() would read it as UTC.
  const bare = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const d = value instanceof Date ? value : bare ? new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])) : new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? "Invalid date" : format(d, pattern);
}
