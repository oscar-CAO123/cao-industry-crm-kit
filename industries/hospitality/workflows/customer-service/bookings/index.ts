// The bookings workflow's two crons. Each reads the bookings sheet and the venue calendar, drafts internal rows, and
// queues any calendar move or removal for approval. No cron sends anything to a guest. Judgment (a clash, a row marked
// Check, a moved or cancelled booking) stays with the person who runs the venue, as SKILL.md describes.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Booking, type Settings, EVENT_ID, WHEN } from "./types.ts";
import * as g from "./adapters/google-workspace.ts";

/** The problem with a booking row, or null when it can be held. */
function problem(b: Booking): string | null {
  if (!b.guest) return "guest name is missing";
  if (b.headcount === null) return "headcount must be a whole number from 1 to 500";
  if (!WHEN.test(b.start) || !WHEN.test(b.end)) return "start and end need a date, a time and an offset, such as 2026-12-05T18:00:00+11:00";
  if (Date.parse(b.end) <= Date.parse(b.start)) return "end is not after start";
  if (b.booked === null || b.booked < 0) return "booked value is missing or negative";
  return null;
}

/** Every 15 minutes: hold each new enquiry the calendar has room for, and record its booked value as the original. */
export async function hold(ctx: Ctx<Settings>) {
  g.checkSettings(ctx.settings);
  const counts = { held: 0, clash: 0, check: 0 };
  for (const b of await g.readBookings(ctx)) {
    if (b.status !== "Enquiry") continue;
    const bad = problem(b);
    if (bad) { await g.writeRow(ctx, { ...b, status: "Check", note: bad }); counts.check++; continue; }
    const free = await g.busy(ctx, b);
    if (free === "unknown") { await g.writeRow(ctx, { ...b, status: "Check", note: "the calendar could not be read for this time" }); counts.check++; continue; }
    if (free) { await g.writeRow(ctx, { ...b, status: "Clash", note: "the calendar is busy at this time" }); counts.clash++; continue; }
    const original = b.original ?? b.booked;
    // Holding is written before the calendar call, so a crash leaves a row a person can check, never a silent second hold.
    await g.writeRow(ctx, { ...b, status: "Holding", original, logged: b.booked });
    try {
      const eventId = await g.hold(ctx, b);
      await g.writeRow(ctx, { ...b, status: "Held", original, logged: b.booked, eventId, note: "" });
      counts.held++;
    } catch {
      await g.writeRow(ctx, { ...b, status: "Check", original, logged: b.booked, note: "the hold did not confirm: check the calendar, then set Enquiry or Held" });
      counts.check++;
    }
  }
  ctx.log(`hold: ${counts.held} held, ${counts.clash} clash, ${counts.check} to check`);
  return counts;
}

/** Daily: queue the calendar moves and removals the sheet asks for, and log each booked-value change once. */
export async function changes(ctx: Ctx<Settings>) {
  g.checkSettings(ctx.settings);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.settings.timezone }).format(ctx.now);
  const logs: unknown[][] = [];
  const writes: Booking[] = [];
  let queued = 0;
  for (const b of await g.readBookings(ctx)) {
    let row = b;
    if (b.status === "Cancelled" && EVENT_ID.test(b.eventId)) { await g.queueRemove(ctx, b); queued++; }
    else if (b.status === "Moved") {
      const bad = !EVENT_ID.test(b.eventId) ? "there is no calendar hold to move" : problem(b);
      if (bad) row = { ...b, status: "Check", note: bad };
      else { await g.queueMove(ctx, b); queued++; }
    }
    if (b.booked !== null && b.logged !== null && b.booked !== b.logged) {
      logs.push([today, b.guest, b.original ?? "", b.logged, b.booked, Math.round((b.booked - b.logged) * 100) / 100]);
      row = { ...row, logged: b.booked };
    }
    if (row !== b) writes.push(row);
  }
  // The log goes first: if a later row write fails, the next run re-logs that row, and the person sees it twice in the tab.
  await g.logChanges(ctx, logs);
  for (const r of writes) await g.writeRow(ctx, r);
  ctx.log(`changes: ${logs.length} logged, ${queued} queued for approval`);
  return { changes: logs.length, queued };
}

export const CRONS = { hold, changes };
