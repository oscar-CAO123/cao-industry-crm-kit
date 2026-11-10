import { format } from "date-fns";

/**
 * Formats a date the way the tables did with moment: a missing or invalid date reads "Invalid date" instead of
 * throwing. The pattern is a date-fns pattern (yyyy, dd, MMM, HH:mm).
 */
export function formatDatePattern(value: unknown, pattern: string): string {
  if (value === null || value === undefined || value === "") return "Invalid date";
  const d = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? "Invalid date" : format(d, pattern);
}
