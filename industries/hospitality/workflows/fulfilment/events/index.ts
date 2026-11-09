// The events workflow's two crons. Each reads Gmail and the venue calendar and drafts or queues. No cron sends anything.
// Judgment (reading an enquiry for its date, times and guest count, and writing them into the bookings namespace) stays
// with the person who runs events, as SKILL.md describes.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { type Booking, type Enquiry, type Settings, WHEN } from "./types.ts";
import * as g from "./adapters/google-workspace.ts";

/** The problem with a booking, or null when a hold can be made. */
function problem(b: Booking, now: Date): string | null {
  if (!WHEN.test(b.start) || !WHEN.test(b.end)) return "start and end need a date, a time and an offset, such as 2026-12-05T18:00:00+11:00";
  if (Date.parse(b.end) <= Date.parse(b.start)) return "end is not after start";
  if (Date.parse(b.start) <= now.getTime()) return "start is in the past";
  if (!Number.isInteger(b.guests) || b.guests < 1 || b.guests > 500) return "guests must be a whole number from 1 to 500";
  return null;
}

/** Every 10 minutes: enquiry emails the list has not seen yet. Reads the sender, subject and threading headers only. */
export async function intake(ctx: Ctx<Settings>) {
  g.checkSettings(ctx.settings);
  let added = 0;
  for (const m of await g.listMessages(ctx)) {
    const id = safeKey(`gmail:${m.id}`);
    if (await ctx.store.get("enquiries", id)) continue;
    const e = await g.readEnquiry(ctx, m);
    const row: Enquiry = e
      ? { id, ...e, status: "new" }
      : { id, message_id: m.id, thread_id: m.threadId, from: "", subject: "", received: ctx.now.toISOString(), status: "skipped", note: "the sender has no email address" };
    await ctx.store.put("enquiries", id, row);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: for each enquiry with booking details, hold a free date, draft the reply in its thread, and queue the send. */
export async function check(ctx: Ctx<Settings>) {
  g.checkSettings(ctx.settings);
  const counts = { held: 0, clash: 0, details: 0, check: 0 };
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => e.status === "new" || e.status === "needs-details");
  for (const first of todo) {
    let e: Enquiry = first;
    const b = await ctx.store.get<Booking>("bookings", e.id);
    const bad = b ? problem(b, ctx.now) : "no booking details yet";
    if (!b || bad) {
      await ctx.store.put("enquiries", e.id, { ...e, status: "needs-details", note: bad ?? undefined });
      counts.details++;
      continue;
    }
    const free = await g.slot(ctx, b);
    if (free === "unknown") { await ctx.store.put("enquiries", e.id, { ...e, status: "check", note: "the calendar could not be read for this time" }); counts.check++; continue; }
    if (free === "busy") { await ctx.store.put("enquiries", e.id, { ...e, status: "clash", note: "the calendar is busy at this time" }); counts.clash++; continue; }
    // Marked before any call, so a crash leaves a row a person can check, never a second hold.
    e = { ...e, status: "holding", note: undefined };
    await ctx.store.put("enquiries", e.id, e);
    let holdId: string;
    try { holdId = await g.hold(ctx, e, b); }
    catch { await ctx.store.put("enquiries", e.id, { ...e, status: "check", note: "the hold did not confirm: check the calendar, then set the enquiry to new" }); counts.check++; continue; }
    e = { ...e, hold_event_id: holdId };
    await ctx.store.put("enquiries", e.id, e);
    let draftId: string;
    try { draftId = await g.draftReply(ctx, e, b); }
    catch { await ctx.store.put("enquiries", e.id, { ...e, status: "check", note: "the hold is in the calendar but the reply draft failed: draft the reply by hand" }); counts.check++; continue; }
    // The summary is logged by the runtime, so it names the enquiry, not the guest's address (the act keeps the address).
    const approval = await ctx.queue(g.sendAct(e, draftId), `Send the reply for enquiry ${e.id} offering ${g.whenLabel(ctx.settings, b)}`);
    await ctx.store.put("enquiries", e.id, { ...e, status: "replied", draft_id: draftId, approval_id: approval });
    counts.held++;
  }
  ctx.log(`check: ${counts.held} held, ${counts.clash} clash, ${counts.details} need details, ${counts.check} to check`);
  return counts;
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, check };
