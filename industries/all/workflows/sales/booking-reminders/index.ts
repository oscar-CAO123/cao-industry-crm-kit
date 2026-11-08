// The booking workflow's two crons. Each reads; the no-show cron queues for a person to decide. Nothing here sends.
// Calendly does not record attendance, so the no-show cron cannot tell who came: it queues each finished booking
// as a yes or no, and a person's rejection stays rejected (the runtime never queues the same key twice).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, Booking } from "./types.ts";
import { config, DAY_MS, text } from "./types.ts";
import { eventsBetween, inviteesOf, NO_SHOW } from "./adapters/calendly.ts";

/** Every 15 minutes: read the next booked appointments from Calendly into the workflow's book. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  const c = config(ctx.settings);
  const now = ctx.now.getTime();
  const events = await eventsBetween(ctx, c.userUri, new Date(now).toISOString(), new Date(now + c.days * DAY_MS).toISOString());
  let added = 0, updated = 0;
  for (const ev of events.slice(0, 50)) {
    for (const inv of await inviteesOf(ctx, ev.uuid)) {
      const key = `calendly:${inv.uuid}`;
      const prev = await ctx.store.get<Booking>("bookings", key);
      await ctx.store.put("bookings", key, {
        key, platform: "calendly", event: ev.uuid, invitee: inv.invitee, name: inv.name, email: inv.email,
        event_name: ev.name, starts: ev.starts, ends: ev.ends, status: inv.status, no_show: inv.no_show,
        seen: ctx.now.toISOString(),
      } satisfies Booking);
      if (prev) updated++; else added++;
    }
  }
  ctx.log(`intake: ${added} new, ${updated} seen again`);
  return { added, updated };
}

/** Every 30 minutes: queue a yes or no for each finished booking with no no-show yet, oldest first, for a person to decide. */
export async function noShow(ctx: Ctx<Settings>) {
  const c = config(ctx.settings);
  const now = ctx.now.getTime();
  const due = Object.values(await ctx.store.list<Booking>("bookings"))
    .filter((b) => {
      const end = Date.parse(b.ends);
      return b.platform === "calendly" && b.status === "active" && !b.no_show
        && end <= now - c.graceMs && end >= now - 2 * DAY_MS;
    })
    .sort((a, b) => a.ends.localeCompare(b.ends))
    .slice(0, 20);
  let queued = 0, skipped = 0;
  for (const b of due) {
    // Read the event again: the booking may have been cancelled or marked since intake ran.
    const fresh = (await inviteesOf(ctx, b.event)).find((i) => i.invitee === b.invitee);
    if (!fresh || fresh.status !== "active" || fresh.no_show) { skipped++; continue; }
    const who = text(b.name || b.email || "a booked client", 120);
    const when = text(b.event_name || "the booking", 120);
    await ctx.queue({
      platform: "calendly", op: NO_SHOW, input: { body: { invitee: b.invitee } },
      key: `noshow:${fresh.uuid}`,
      summary: `Did ${who} attend ${when} at ${b.starts}? Approve to mark a no-show. Reject if they came.`,
    });
    queued++;
  }
  ctx.log(`no-show: ${queued} queued or already queued, ${skipped} skipped`);
  return { queued, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, "no-show": noShow };
