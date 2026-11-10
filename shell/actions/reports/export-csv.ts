import type { ChartDataPoint } from "./types";

function escapeCSV(value: string | number): string {
  let str = String(value);
  // A text cell that starts with = + - @ or a tab or return would run as a formula when the file is opened in a spreadsheet.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function generateCSV(data: ChartDataPoint[], headers: string[]): string {
  const headerRow = headers.join(",");
  if (data.length === 0) return headerRow;
  const rows = data.map((row) => [escapeCSV(row.name), escapeCSV(row.Number)].join(","));
  return [headerRow, ...rows].join("\n");
}
