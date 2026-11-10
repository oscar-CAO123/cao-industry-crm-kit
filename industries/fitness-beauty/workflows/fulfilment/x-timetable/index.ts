// The class timetable's three crons. Each reads, writes to the store, or queues. None sends to a member on its own.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Proposal, type Settings, type Snapshot, DAY, ID, WHEN, clean, lookahead, target } from "./types.ts";
import { bookeo } from "./adapters/bookeo.ts";

const SNAP = "current";
const FRESH_MS = 60 * 60_000;   // the snapshot cron runs hourly: an older snapshot cannot say what is booked now

/** Hourly: the next weeks of classes, their seats, bookings and room blocks. Reads only. */
async function snapshot(ctx: Ctx<Settings>) {
  const from = ctx.now.toISOString(), to = new Date(ctx.now.getTime() + lookahead(ctx.settings) * DAY).toISOString();
  const products = await bookeo.products(ctx);
  const wanted = new Set(ctx.settings.product_ids ?? []);
  const slots = (await bookeo.slots(ctx, from, to)).filter((s) => !wanted.size || wanted.has(s.productId));
  const bookings = await bookeo.bookings(ctx, from, to);
  const blocks = await bookeo.blocks(ctx, from, to);
  const snap: Snapshot = { taken: from, from, to, products, slots, bookings, blocks };
  await ctx.store.put("snapshot", SNAP, snap);
  ctx.log(`snapshot: ${slots.length} classes, ${bookings.length} bookings, ${blocks.length} blocks`);
  return { slots: slots.length, bookings: bookings.length, blocks: blocks.length };
}

/** Daily: classes under the fill target, stored for the owner's weekly review. Store only. */
async function fillReview(ctx: Ctx<Settings>) {
  const snap = await ctx.store.get<Snapshot>("snapshot", SNAP);
  if (!snap) return { flagged: 0, note: "no snapshot yet" };
  const flagged: { eventId?: string; productId: string; startTime: string; booked: number; capacity: number; fill: number }[] = [];
  for (const s of snap.slots) {
    const booked = snap.bookings.filter((b) => b.eventId === s.eventId && !b.canceled).length;
    const left = typeof s.numSeatsAvailable === "number" ? s.numSeatsAvailable : 0;
    const capacity = left + booked;   // approximation: seats left plus booked; see gaps
    if (capacity <= 0) continue;
    const fill = Math.round((booked / capacity) * 100);
    if (fill < target(ctx.settings)) flagged.push({ eventId: s.eventId, productId: s.productId, startTime: s.startTime, booked, capacity, fill });
  }
  const day = ctx.now.toISOString().slice(0, 10);
  await ctx.store.put("fill", day, { day, target: target(ctx.settings), flagged, taken: ctx.now.toISOString() });
  ctx.log(`fill-review: ${flagged.length} class(es) under ${target(ctx.settings)}%`);
  return { flagged: flagged.length };
}

/** Every 15 minutes: queue the owner's or agent's proposed cancellations and room blocks for approval. */
async function changeQueue(ctx: Ctx<Settings>) {
  const snap = await ctx.store.get<Snapshot>("snapshot", SNAP);
  const pending = Object.values(await ctx.store.list<Proposal>("proposals")).filter((p) => p.status === "pending" || !p.status);
  let queued = 0, rejected = 0;
  for (const p of pending) {
    const reject = async (error: string) => { rejected++; await ctx.store.put("proposals", p.id, { ...p, status: "rejected", error }); };
    if (!ID.test(String(p.id))) { await reject("bad proposal id"); continue; }
    const reason = clean(p.reason, 200);
    if (!reason) { await reject("a reason is required"); continue; }
    if (p.action === "cancel-class") {
      if (!p.productId || !ID.test(p.productId) || !p.startTime || !WHEN.test(p.startTime)) { await reject("cancel-class needs a valid productId and startTime"); continue; }
      // No snapshot, or one older than the hourly cron: the proposal stays pending until a fresh one can say who is booked.
      if (!snap || ctx.now.getTime() - Date.parse(snap.taken) > FRESH_MS) continue;
      const at = Date.parse(p.startTime);
      const hits = snap.bookings.filter((b) => b.productId === p.productId && !b.canceled && Date.parse(b.startTime ?? "") === at);
      if (!hits.length) { await ctx.store.put("proposals", p.id, { ...p, status: "no-bookings" }); continue; }
      const ids: string[] = [];
      for (let i = 0; i < hits.length; i += 5) {                   // an approval holds up to 5 acts
        const chunk = hits.slice(i, i + 5).map((b) => bookeo.cancelAct(b.bookingNumber, reason));
        ids.push(await ctx.queue(chunk, `cancel ${chunk.length} booking(s) for ${p.productId} at ${p.startTime}, notify customers: ${reason}`));
      }
      queued += ids.length;
      await ctx.store.put("proposals", p.id, { ...p, status: "queued", approvals: ids });
    } else if (p.action === "block-room") {
      const rids = (p.resourceIds ?? []).map((r) => String(r));
      if (!rids.length || !rids.every((r) => ID.test(r)) || !p.blockStart || !p.blockEnd || !WHEN.test(p.blockStart) || !WHEN.test(p.blockEnd)) { await reject("block-room needs valid resourceIds, blockStart and blockEnd"); continue; }
      const id = await ctx.queue(bookeo.blockAct(rids, p.blockStart, p.blockEnd, reason, `block.${p.id}`), `block ${rids.join(", ")} ${p.blockStart} to ${p.blockEnd}: ${reason}`);
      queued++;
      await ctx.store.put("proposals", p.id, { ...p, status: "queued", approvals: [id] });
    } else {
      await reject("unknown action");
    }
  }
  ctx.log(`change-queue: ${queued} queued, ${rejected} rejected`);
  return { queued, rejected };
}

export const CRONS = { snapshot, fillReview, changeQueue };
