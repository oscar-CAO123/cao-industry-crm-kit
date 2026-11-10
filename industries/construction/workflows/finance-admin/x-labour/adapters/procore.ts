// Procore: the hours each person worked in a pay period, read from the company timecard list. Read only. Field names come
// from Procore's own timesheets reference page (developers.procore.com/reference/rest/v1/timesheets, read 11 Nov 2026):
// GET /rest/v1.0/companies/{company_id}/timesheets takes start_date, end_date (YYYY-MM-DD), page, per_page and
// skip_saving_sticky_filters, and returns an array of { party: { id, name }, timecard_entries: [{ id, date, hours (a string such
// as "5.0"), deleted_at, timesheet_status: { status } }] }. The page marks timesheet_status "Deprecated" and documents the
// entry's own approval_status (pending, reviewed, approved, completed, rejected) on the write side, so the status is read from
// approval_status when the entry carries it and from timesheet_status.status otherwise. The company id is pinned from PROCORE_COMPANY_ID by the platform file.
// Each timecard entry is one block of hours, so it is one "shift" for the rest of this workflow.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings, Shift } from "../types.ts";

const P = "procore";
const PER_PAGE = 100;
export const MAX_TIMECARD_PAGES = 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The approval statuses Procore documents for a timecard entry. A setting outside this list would mirror nothing, so it is refused. */
export const APPROVAL_STATUSES = ["pending", "reviewed", "approved", "completed", "rejected"];
const statusOf = (e: any) => String(e?.approval_status || e?.timesheet_status?.status || "").trim().toLowerCase();

/** Hours in one entry above this are not hours: a day has 24. Anything else that is not a positive number is a bad row. */
const MAX_ENTRY_HOURS = 24;

export interface ProcoreHours { shifts: Shift[]; bad: number; notMirrored: number }

/**
 * Every timecard entry in the pay period whose approval status is the one the business mirrors (settings.procore.mirror_status,
 * one of the five documented words).
 * Paging runs until a page comes back empty; a period past 20 pages is refused whole. A row that does not check out (no usable
 * id, no date, or hours that are missing or not a number between 0 and 24) is counted in `bad`, never guessed at. Deleted entries,
 * entries in another status and entries dated outside the period are left out; the first two are counted in `notMirrored`, and the
 * statuses seen are logged so a status that never matches is visible.
 */
export async function timecardHours(ctx: Ctx<Settings>, p: { start: string; end: string }): Promise<ProcoreHours> {
  const want = String(ctx.settings.procore?.mirror_status ?? "").trim().toLowerCase();
  if (!want) throw new Error("procore: set procore.mirror_status in settings (the timecard approval status whose hours are paid, for example approved)");
  if (!APPROVAL_STATUSES.includes(want)) throw new Error(`procore: procore.mirror_status must be one of ${APPROVAL_STATUSES.join(", ")}`);
  const byId = new Map<number, Shift>();
  let bad = 0, notMirrored = 0;
  const seen = new Map<string, number>();
  for (let page = 1; page <= MAX_TIMECARD_PAGES; page++) {
    const r = await ctx.draft<any[]>({ platform: P, op: "timesheets.list-timecard-data", summary: `Procore timecards ${p.start} to ${p.end}, page ${page}`,
      input: { params: { start_date: p.start, end_date: p.end, page, per_page: PER_PAGE, skip_saving_sticky_filters: true } } });
    // A 200 that is not a list is a failed read, never an empty page: an empty page would end the period early and under-pay.
    if (!Array.isArray(r.data)) throw new Error("procore: the timecard list did not come back as a list");
    if (r.data.length === 0) {
      ctx.log(`procore: ${byId.size} entries mirrored, ${notMirrored} not (statuses seen: ${[...seen].map(([k, v]) => `${k || "none"} ${v}`).join(", ") || "no entries"})`);
      return { shifts: [...byId.values()], bad, notMirrored };
    }
    for (const person of r.data) {
      const staff = Number.isInteger(person?.party?.id) && person.party.id > 0 ? String(person.party.id) : "";
      for (const e of Array.isArray(person?.timecard_entries) ? person.timecard_entries : []) {
        if (e?.deleted_at) { notMirrored++; continue; }
        // Number(null) and Number("") are 0, so a missing value is checked before it is converted.
        const raw = e?.hours, hours = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "") ? Number(raw) : NaN;
        const date = String(e?.date ?? "");
        if (!staff || !Number.isInteger(e?.id) || e.id <= 0 || !DAY.test(date) || !Number.isFinite(hours) || hours < 0 || hours > MAX_ENTRY_HOURS) { bad++; continue; }
        if (date < p.start || date > p.end) continue;
        const st = statusOf(e);
        seen.set(st, (seen.get(st) ?? 0) + 1);
        if (st !== want) { notMirrored++; continue; }
        if (hours === 0) continue;
        byId.set(e.id, { key: `procore-${e.id}`, staff, date, hours: Math.round(hours * 100) / 100 });
      }
    }
  }
  throw new Error(`procore: the timecard list for ${p.start} to ${p.end} is longer than ${MAX_TIMECARD_PAGES} pages; refused whole`);
}
