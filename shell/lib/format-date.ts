import { format } from "date-fns";

/**
 * Formats a date the way the tables did with moment: a missing or invalid date reads "Invalid date" instead of
 * throwing. The pattern is a date-fns pattern (yyyy, dd, MMM, HH:mm).
 */
export function formatDatePattern(value: unknown, pattern: string): string {
  if (value === null || value === undefined || value === "") return "Invalid date";
  try {
    let d: Date;
    // A bare date ("2026-01-02") is a calendar day in the viewer's own zone, as moment read it; new Date() would read it as UTC.
    const bare = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    if (bare) {
      const [y, m, day] = [Number(bare[1]), Number(bare[2]), Number(bare[3])];
      d = new Date(y, m - 1, day);
      // An impossible day (2026-02-30, 2026-13-45) would roll over into the next month or year; moment rejects it.
      if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== day) return "Invalid date";
    } else {
      d = value instanceof Date ? value : new Date(value as string | number);
    }
    return Number.isNaN(d.getTime()) ? "Invalid date" : format(d, pattern);
  } catch {
    return "Invalid date"; // a Symbol, a BigInt or anything else new Date() cannot take
  }
}
