// The shift note workflow's two crons. Both read or draft; neither sends anything to a worker or a client.
// Judgment (whether a note is good care, whether a concern needs escalating) stays with the supervisor. The checks here
// only flag a note that misses a point listed in settings, and leave a review comment on its timesheet.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { checkNote, keyOf, reviewText, timesheetId, type Settings, type ShiftNote } from "./types.ts";
import { timesheetsSince, commentsOn, reviewComment } from "./adapters/deputy.ts";

const MARK = "Shift note check (automatic";

/** Every 15 minutes: keep each new shift note (a timesheet with text) that is not already in the store. */
export async function collect(ctx: Ctx<Settings>) {
  const rows = await timesheetsSince(ctx, ctx.settings.lookback_days ?? 1);
  let added = 0, skipped = 0;
  for (const row of rows) {
    const id = timesheetId(row.Id), note = String(row.EmployeeComment ?? "").trim();
    if (!id || !note) { skipped++; continue; }                       // a bad id never becomes a path; an empty note has nothing to check
    const key = keyOf(id);
    if (await ctx.store.get("shiftnotes", key)) continue;
    await ctx.store.put("shiftnotes", key, { key, platform: "deputy", timesheet_id: id, date: String(row.Date ?? "").slice(0, 10), note, status: "new", created: ctx.now.toISOString() } satisfies ShiftNote);
    added++;
  }
  ctx.log(`collect: ${added} new, ${skipped} skipped`);
  return { added, skipped };
}

/** Hourly: check each new note against the points in settings. A note that misses one gets one review comment on its timesheet. */
export async function check(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<ShiftNote>("shiftnotes")).filter((n) => n.status === "new");
  let ok = 0, flagged = 0;
  for (const n of todo) {
    const gaps = checkNote(n.note, ctx.settings);
    if (!gaps.length) { await ctx.store.put("shiftnotes", n.key, { ...n, status: "ok" }); ok++; continue; }
    // A comment from an earlier run that the store did not record: never add a second one.
    const existing = await commentsOn(ctx, n.timesheet_id);
    const already = existing.some((c: any) => String(c?.Comment ?? "").startsWith(MARK));
    if (!already) await reviewComment(ctx, n.timesheet_id, reviewText(gaps));
    await ctx.store.put("shiftnotes", n.key, { ...n, status: "flagged", gaps, reviewed_at: ctx.now.toISOString() });
    flagged++;
  }
  ctx.log(`check: ${ok} ok, ${flagged} flagged`);
  return { ok, flagged };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { collect, check };
