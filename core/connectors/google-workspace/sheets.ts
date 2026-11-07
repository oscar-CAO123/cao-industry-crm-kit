// NEW: the CRM has no Sheets code. Written from Google's Sheets docs, not yet run in production.
//
// Google Sheets helper: read a range and append rows. Many owners run the business from a sheet,
// so this is often the first place a workflow reads from or reports to.

import { call } from "../../lib/http.ts";
import { accessToken, SCOPES, spec } from "./auth.ts";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const enc = encodeURIComponent;

export async function readRange(mailbox: string, sheetId: string, range: string): Promise<string[][]> {
  const h = { Authorization: `Bearer ${await accessToken(mailbox, SCOPES.sheetsRead)}` };
  const r = await call<any>(spec, { url: `${API}/${enc(sheetId)}/values/${enc(range)}`, headers: h });
  return r.data?.values ?? [];
}

/** Rows as objects keyed by the first row's headers. */
export function asRecords(values: string[][]): Record<string, string>[] {
  const [head = [], ...rows] = values;
  return rows.map((row) => Object.fromEntries(head.map((k, i) => [k, row[i] ?? ""])));
}

/** Appends rows under a table. Needs KIT_ALLOW_WRITES=1. Values go in as typed, not as formulas. */
export async function appendRows(mailbox: string, sheetId: string, range: string, rows: (string | number)[][]): Promise<number> {
  const h = { Authorization: `Bearer ${await accessToken(mailbox, SCOPES.sheetsWrite)}` };
  const r = await call<any>(spec, {
    method: "POST", url: `${API}/${enc(sheetId)}/values/${enc(range)}:append`, headers: h,
    query: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" }, json: { values: rows },
  });
  return r.data?.updates?.updatedRows ?? 0;
}
