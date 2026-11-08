// The event ticketing workflow's four crons. Each reads Eventbrite and drafts into the workflow store. Only setup queues
// anything, and that is a publish a person approves. Venues, suppliers and catering are outside this workflow (see gaps).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Register, Settings } from "./types.ts";
import { attendees, eventIds, isId, queuePublish, readEvent, teams, ticketClasses } from "./adapters/eventbrite.ts";

const DAY = 864e5;
const startMs = (ev: { start?: { utc?: string } }) => (ev.start?.utc ? Date.parse(ev.start.utc) : NaN);
const endMs = (ev: { end?: { utc?: string } }) => (ev.end?.utc ? Date.parse(ev.end.utc) : NaN);

/** Hourly: an event still in draft, with at least one ticket type and a venue (or online), is queued to publish. */
export async function setup(ctx: Ctx<Settings>) {
  let ready = 0, queued = 0, waiting = 0;
  for (const id of eventIds(ctx)) {
    const ev = await readEvent(ctx, id);
    if (ev.status !== "draft") continue;
    const types = await ticketClasses(ctx, id);
    const placed = ev.online_event === true || !!ev.venue_id;
    if (!types.length || !placed) {
      waiting++;
      ctx.log(`setup ${id}: waiting for ${!types.length ? "a ticket type" : "a venue"}`);
      continue;
    }
    ready++;
    if (!ctx.settings.publish_when_ready) continue;
    await queuePublish(ctx, id, `Publish "${ev.name?.text ?? id}" with ${types.length} ticket type(s)`);
    queued++;
  }
  ctx.log(`setup: ${ready} ready, ${queued} queued, ${waiting} waiting`);
  return { ready, queued, waiting };
}

/** Every 30 minutes: attendees changed since the last run, kept as the register. Email addresses are not kept. */
export async function registrations(ctx: Ctx<Settings>) {
  let seen = 0, incomplete = 0;
  for (const id of eventIds(ctx)) {
    const cursorKey = `attendees-${id}`;
    const cursor = await ctx.store.get<{ changed_since: string }>("cursor", cursorKey);
    const { items, more } = await attendees(ctx, id, cursor?.changed_since);
    if (more) { incomplete++; ctx.log(`registrations ${id}: more than one page of attendees, register incomplete`); }
    for (const a of items) {
      const aid = String(a.id ?? "");
      if (!isId(aid)) continue;
      const row: Register = { event_id: id, attendee_id: aid, order_id: a.order_id, name: a.profile?.name, ticket_class: a.ticket_class_name,
        status: a.status, checked_in: a.checked_in === true, cancelled: a.cancelled === true, refunded: a.refunded === true, changed: a.changed };
      await ctx.store.put("register", `${id}-${aid}`, row);
      seen++;
    }
    // Advance the cursor only when the whole window was read, so a partial page is never treated as complete.
    const newest = items.map((a) => a.changed ?? "").filter(Boolean).sort().at(-1);
    if (newest && !more) await ctx.store.put("cursor", cursorKey, { changed_since: newest });
  }
  ctx.log(`registrations: ${seen} attendees read, ${incomplete} event(s) incomplete`);
  return { attendees_read: seen, incomplete };
}

/** Daily: each event starting within the run-sheet window gets a drafted run sheet from its times and check-in teams. */
export async function runDay(ctx: Ctx<Settings>) {
  const days = ctx.settings.run_sheet_days_ahead ?? 7;
  const now = ctx.now.getTime();
  let drafted = 0, skipped = 0;
  for (const id of eventIds(ctx)) {
    const ev = await readEvent(ctx, id);
    const start = startMs(ev), end = endMs(ev);
    if (!(start - now <= days * DAY) || !(end >= now)) { skipped++; continue; } // NaN times are skipped too
    const ts = await teams(ctx, id);
    await ctx.store.put("run-sheets", `event-${id}`, {
      event_id: id, name: ev.name?.text, status: ev.status, start: ev.start, end: ev.end,
      timezone: ctx.settings.timezone ?? ev.start?.timezone, venue_id: ev.venue_id ?? null, online: ev.online_event === true,
      teams: ts.map((t) => ({ name: t.name, attendees: t.attendee_count ?? 0 })), drafted: ctx.now.toISOString(),
    });
    drafted++;
  }
  ctx.log(`run-day: ${drafted} run sheet(s) drafted, ${skipped} skipped`);
  return { drafted, skipped };
}

/** Daily: each event that has ended gets drafted counts per ticket type: sold, checked in, cancelled and refunded. */
export async function wrapUp(ctx: Ctx<Settings>) {
  const now = ctx.now.getTime();
  let drafted = 0, waiting = 0, incomplete = 0;
  for (const id of eventIds(ctx)) {
    const ev = await readEvent(ctx, id);
    if (!(endMs(ev) < now)) { waiting++; continue; } // not ended yet, or no end time
    const { items, more } = await attendees(ctx, id);
    if (more) incomplete++;
    const counts = new Map<string, { sold: number; checked_in: number; cancelled: number; refunded: number }>();
    for (const a of items) {
      const k = a.ticket_class_name ?? "unknown";
      const c = counts.get(k) ?? { sold: 0, checked_in: 0, cancelled: 0, refunded: 0 };
      if (a.cancelled) c.cancelled++; else c.sold++;
      if (a.checked_in) c.checked_in++;
      if (a.refunded) c.refunded++;
      counts.set(k, c);
    }
    await ctx.store.put("wrap-up", `event-${id}`, { event_id: id, name: ev.name?.text, ended: ev.end?.utc,
      attendees_counted: items.length, incomplete: more, by_ticket: Object.fromEntries(counts), drafted: ctx.now.toISOString() });
    drafted++;
  }
  ctx.log(`wrap-up: ${drafted} drafted, ${waiting} not ended, ${incomplete} incomplete`);
  return { drafted, waiting, incomplete };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { setup, registrations, "run-day": runDay, "wrap-up": wrapUp };
