// Google Workspace: the venue's waitlist spreadsheet and its guest log. Reads the waitlist, writes positions and
// quoted waits back, appends to the guest log. Clearing a waitlist row removes it from the host's view, so it is only
// ever queued for a person to approve.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { cell, COLUMNS, STATUSES, SHEET_ID, TAB, TZ, type Entry, type Settings } from "../types.ts";

const P = "google-workspace";
const LAST = String.fromCharCode(64 + COLUMNS.length);   // "H"

/** Refuses bad settings before any call: the ids and tab names go into request paths. */
export function checkSettings(s: Settings): void {
  const g = s.google_workspace;
  if (!g || !SHEET_ID.test(g.spreadsheet_id ?? "")) throw new Error("google_workspace.spreadsheet_id is not set or is not a Google spreadsheet id");
  for (const t of [g.waitlist_tab ?? "Waitlist", g.log_tab ?? "Guest log"]) if (!TAB.test(t)) throw new Error("tab names may hold letters, digits, spaces, _ and - only");
  if (!TZ.test(s.timezone ?? "")) throw new Error("timezone must be an IANA name, such as Australia/Sydney");
  const m = s.minutes_per_group ?? 15;
  if (!Number.isInteger(m) || m < 1 || m > 240) throw new Error("minutes_per_group must be a whole number from 1 to 240");
}
const tabs = (ctx: Ctx<Settings>) => ({ waitlist: ctx.settings.google_workspace.waitlist_tab ?? "Waitlist", log: ctx.settings.google_workspace.log_tab ?? "Guest log" });
const sheet = (ctx: Ctx<Settings>) => ctx.settings.google_workspace.spreadsheet_id;

/** A value safe for a spreadsheet cell: text is escaped against formulas, numbers stay numbers. */
const safe = (v: unknown): unknown => (typeof v === "number" ? v : cell(v ?? ""));
const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const num = (v: unknown): number | null => {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const whole = (v: unknown): number | null => { const n = num(v); return n !== null && Number.isInteger(n) && n >= 1 && n <= 500 ? n : null; };
const status = (v: unknown): string => { const s = str(v, 20); return STATUSES.find((x) => x.toLowerCase() === s.toLowerCase()) ?? s; };

/** Every non-empty row under the header, read from the waitlist tab. Refuses a tab whose header differs. */
export async function readWaitlist(ctx: Ctx<Settings>): Promise<Entry[]> {
  const r = await ctx.draft<{ values?: unknown[][] }>({ platform: P, op: "sheets.spreadsheets.values.get", summary: "read the waitlist sheet",
    input: { params: { spreadsheetId: sheet(ctx), range: tabs(ctx).waitlist } } });
  const grid = (r.data?.values ?? []) as unknown[][];
  const head = (grid[0] ?? []).slice(0, COLUMNS.length).map((x) => str(x, 60));
  if (COLUMNS.some((c, i) => head[i] !== c)) throw new Error(`the waitlist tab must start with these columns, in order: ${COLUMNS.join(" | ")}`);
  return grid.slice(1)
    .map((v, i): Entry => ({
      row: i + 2, guest: str(v[0], 120), party: whole(v[1]), added: str(v[2], 40), quoted: num(v[3]), position: num(v[4]),
      status: status(v[5]), outcome: str(v[6], 40), note: str(v[7], 50000),
    }))
    .filter((e) => e.guest !== "" || e.added !== "" || e.status !== "");
}

/** Writes one whole row back to the waitlist tab (an internal record, drafted). */
export async function writeEntry(ctx: Ctx<Settings>, e: Entry): Promise<void> {
  const values = [[e.guest, e.party ?? "", e.added, e.quoted ?? "", e.position ?? "", e.status, e.outcome, e.note].map((v) => safe(v))];
  await ctx.draft({ platform: P, op: "sheets.spreadsheets.values.update", summary: `waitlist row ${e.row}: ${e.status}`,
    input: { params: { spreadsheetId: sheet(ctx), range: `${tabs(ctx).waitlist}!A${e.row}:${LAST}${e.row}`, valueInputOption: "RAW" }, body: { majorDimension: "ROWS", values } } });
}

/** Appends rows to the guest log: an internal record, drafted, never sent. */
export async function logRows(ctx: Ctx<Settings>, rows: unknown[][]): Promise<void> {
  if (!rows.length) return;
  await ctx.draft({ platform: P, op: "sheets.spreadsheets.values.append", summary: `log ${rows.length} guest(s) who left the queue`,
    input: { params: { spreadsheetId: sheet(ctx), range: tabs(ctx).log, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
      body: { majorDimension: "ROWS", values: rows.map((r) => r.map(safe)) } } });
}

/** Queue the clearing of a waitlist row for approval. The log comes first, so a cleared row is never lost. */
export async function queueClear(ctx: Ctx<Settings>, e: Entry, key: string): Promise<void> {
  const who = e.guest || `row ${e.row}`;
  await ctx.queue({ platform: P, op: "sheets.spreadsheets.values.clear", key: `clear:${key}`, summary: `clear the waitlist row for ${who} (${e.status})`,
    input: { params: { spreadsheetId: sheet(ctx), range: `${tabs(ctx).waitlist}!A${e.row}:${LAST}${e.row}` }, body: {} } },
    `Clear ${who} from the waitlist (${e.status}, row ${e.row}), after it is logged`);
}

