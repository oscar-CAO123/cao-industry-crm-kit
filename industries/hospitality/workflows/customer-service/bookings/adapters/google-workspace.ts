// Google Workspace: the bookings spreadsheet and the venue calendar. Reads the sheet, checks the calendar for clashes,
// puts a hold on the calendar with no guests invited, writes rows back and logs booked-value changes. A calendar move
// or removal reaches the calendar staff use, so it is only ever queued for a person to approve.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { cell, COLUMNS, STATUSES, CALENDAR, EVENT_ID, SHEET_ID, TAB, TZ, type Booking, type Settings } from "../types.ts";

const P = "google-workspace";
const LAST = String.fromCharCode(64 + COLUMNS.length);   // "J"

/** Refuses bad settings before any call: the ids and tab names go into request paths. */
export function checkSettings(s: Settings): void {
  const g = s.google_workspace;
  if (!g || !SHEET_ID.test(g.spreadsheet_id ?? "")) throw new Error("google_workspace.spreadsheet_id is not set or is not a Google spreadsheet id");
  if (!CALENDAR.test(g.calendar_id ?? "")) throw new Error("google_workspace.calendar_id must be an email address or primary");
  for (const t of [g.bookings_tab ?? "Bookings", g.changes_tab ?? "Changes"]) if (!TAB.test(t)) throw new Error("tab names may hold letters, digits, spaces, _ and - only");
  if (!TZ.test(s.timezone ?? "")) throw new Error("timezone must be an IANA name, such as Australia/Sydney");
}
const tabs = (ctx: Ctx<Settings>) => ({ bookings: ctx.settings.google_workspace.bookings_tab ?? "Bookings", changes: ctx.settings.google_workspace.changes_tab ?? "Changes" });
const sheet = (ctx: Ctx<Settings>) => ctx.settings.google_workspace.spreadsheet_id;
const cal = (ctx: Ctx<Settings>) => ctx.settings.google_workspace.calendar_id;
const when = (ctx: Ctx<Settings>, dt: string) => ({ dateTime: dt, timeZone: ctx.settings.timezone });
/** A value safe for a spreadsheet cell: text is escaped against formulas, numbers stay numbers. */
const safe = (v: unknown): unknown => (typeof v === "number" ? v : cell(v ?? ""));

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const num = (v: unknown): number | null => {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const whole = (v: unknown): number | null => { const n = num(v); return n !== null && Number.isInteger(n) && n >= 1 && n <= 500 ? n : null; };
const status = (v: unknown): string => { const s = str(v, 20); return STATUSES.find((x) => x.toLowerCase() === s.toLowerCase()) ?? s; };

/** Every row under the header, read from the bookings tab. Refuses a tab whose header differs. */
export async function readBookings(ctx: Ctx<Settings>): Promise<Booking[]> {
  const r = await ctx.draft<{ values?: unknown[][] }>({ platform: P, op: "sheets.spreadsheets.values.get", summary: "read the bookings sheet",
    input: { params: { spreadsheetId: sheet(ctx), range: tabs(ctx).bookings } } });
  const grid = (r.data?.values ?? []) as unknown[][];
  const head = (grid[0] ?? []).slice(0, COLUMNS.length).map((x) => str(x, 60));
  if (COLUMNS.some((c, i) => head[i] !== c)) throw new Error(`the bookings tab must start with these columns, in order: ${COLUMNS.join(" | ")}`);
  return grid.slice(1).map((v, i): Booking => ({
    row: i + 2, guest: str(v[0], 120), headcount: whole(v[1]), start: str(v[2], 40), end: str(v[3], 40),
    booked: num(v[4]), original: num(v[5]), logged: num(v[6]), status: status(v[7]), eventId: str(v[8], 1024), note: str(v[9], 300),
  }));
}

/** Writes one whole row back to the bookings tab (an internal record, drafted). */
export async function writeRow(ctx: Ctx<Settings>, b: Booking): Promise<void> {
  const values = [[b.guest, b.headcount, b.start, b.end, b.booked, b.original, b.logged, b.status, b.eventId, b.note].map((v) => safe(v ?? ""))];
  await ctx.draft({ platform: P, op: "sheets.spreadsheets.values.update", summary: `bookings row ${b.row}: ${b.status}`,
    input: { params: { spreadsheetId: sheet(ctx), range: `${tabs(ctx).bookings}!A${b.row}:${LAST}${b.row}`, valueInputOption: "RAW" }, body: { majorDimension: "ROWS", values } } });
}

/** true when the calendar is busy at the booking's time, false when it is free, "unknown" when Google does not say. */
export async function busy(ctx: Ctx<Settings>, b: Booking): Promise<boolean | "unknown"> {
  const id = cal(ctx);
  const r = await ctx.draft<any>({ platform: P, op: "calendar.freebusy.query", summary: `calendar check for row ${b.row}`,
    input: { body: { timeMin: b.start, timeMax: b.end, timeZone: ctx.settings.timezone, items: [{ id }] } } });
  const c = r.data?.calendars?.[id];
  if (!c || (c.errors ?? []).length) return "unknown";
  const s = Date.parse(b.start), e = Date.parse(b.end);
  return (c.busy ?? []).some((x: any) => Date.parse(x.start) < e && Date.parse(x.end) > s);
}

/** A hold on the venue calendar: an opaque event with no guests, so Google sends no invitation. Returns the event id. */
export async function hold(ctx: Ctx<Settings>, b: Booking): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "calendar.events.insert", summary: `calendar hold for row ${b.row}`,
    input: { params: { calendarId: cal(ctx), sendUpdates: "none" }, body: {
      summary: `HOLD ${b.guest} (${b.headcount})`.slice(0, 120),
      description: `Held from the bookings sheet, row ${b.row}. Not an invitation.`,
      start: when(ctx, b.start), end: when(ctx, b.end), transparency: "opaque",
      extendedProperties: { private: { bookings_row: String(b.row) } } } } });
  const id = String(r.data?.id ?? "");
  if (!EVENT_ID.test(id)) throw new Error("google-workspace: the hold came back without an event id");
  return id;
}

/** Queue the removal of a calendar hold for approval. */
export async function queueRemove(ctx: Ctx<Settings>, b: Booking): Promise<void> {
  const who = b.guest || `row ${b.row}`;
  await ctx.queue({ platform: P, op: "calendar.events.delete", key: `cancel:${b.eventId}`, summary: `remove the calendar hold for ${who}`,
    input: { params: { calendarId: cal(ctx), eventId: b.eventId, sendUpdates: "none" } } }, `Remove the calendar hold for ${who} (cancelled in the sheet)`);
}

/** Queue a move of a calendar hold to the times in the sheet, for approval. */
export async function queueMove(ctx: Ctx<Settings>, b: Booking): Promise<void> {
  const who = b.guest || `row ${b.row}`;
  await ctx.queue({ platform: P, op: "calendar.events.patch", key: `move:${b.eventId}:${b.start}`, summary: `move the calendar hold for ${who}`,
    input: { params: { calendarId: cal(ctx), eventId: b.eventId, sendUpdates: "none" },
      body: { start: when(ctx, b.start), end: when(ctx, b.end) } } }, `Move the calendar hold for ${who} to ${b.start}`);
}

/** Append booked-value changes to the changes tab: an internal log, drafted, never sent. */
export async function logChanges(ctx: Ctx<Settings>, rows: unknown[][]): Promise<void> {
  if (!rows.length) return;
  await ctx.draft({ platform: P, op: "sheets.spreadsheets.values.append", summary: `log ${rows.length} booked-value change(s)`,
    input: { params: { spreadsheetId: sheet(ctx), range: tabs(ctx).changes, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
      body: { majorDimension: "ROWS", values: rows.map((r) => r.map(safe)) } } });
}
