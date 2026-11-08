// The comp and discount watch's two crons. The watch cron reads each venue's new paid sales and their discounts from
// Square. The report cron counts a day's records from the workflow store. Neither sends, voids, refunds or changes a
// sale, so no live operation is used here.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { LOC, ORDER_ID, cut, localDay, round, type CompCtx, type DailyReport, type Discount, type OrderRecord, type Settings, type Venue, type Watermark } from "./types.ts";
import { payments, order, type Order, type OrderDiscount } from "./adapters/square.ts";

const H = 3600e3;
const OVERLAP_MS = 15 * 60e3;   // each run re-reads the last 15 minutes, so a late payment is caught; sales already read are skipped
const FIRST_RUN_MS = 24 * H;    // the first run looks back a day
const MAX_PAGES = 5;            // payment pages per venue per run; a busier window carries on at the next run
const PAID = new Set(["APPROVED", "COMPLETED"]);

/** Checks the venue list and the rules from settings before any call. */
export function venues(s: Settings): Venue[] {
  if (!Number.isFinite(s.utc_offset_hours) || s.utc_offset_hours < -12 || s.utc_offset_hours > 14) throw new Error("comps: utc_offset_hours out of range");
  const over = s.review_over_pct ?? 10;
  if (!(over >= 0 && over <= 100)) throw new Error("comps: review_over_pct must be from 0 to 100");
  if (!Array.isArray(s.venues) || !s.venues.length) throw new Error("comps: settings.venues is empty");
  return s.venues.map((v) => {
    if (typeof v.square_location_id !== "string" || !LOC.test(v.square_location_id)) throw new Error(`comps: ${cut(v.name, 40)}: square_location_id must be a Square location id`);
    return { ...v, name: cut(v.name, 80) };
  });
}

/** Each discount on a sale, in plain dollars and percentages. */
export function discountsOf(o: Order): Discount[] {
  return (o.discounts ?? []).slice(0, 50).map((d: OrderDiscount): Discount => {
    const pct = d.percentage === undefined || d.percentage === "" ? NaN : Number(d.percentage);
    const cents = d.applied_money?.amount;
    return { name: cut(d.name || "Unnamed discount", 80), pct: Number.isFinite(pct) ? pct : null,
      dollars: Number.isSafeInteger(cents) ? round(Number(cents) / 100) : 0, scope: d.scope ? cut(d.scope, 20) : undefined };
  });
}

/** Why a sale is flagged: a discount not on the allowed list, a percentage over the threshold, or a 100 percent comp. */
export function flagsFor(s: Settings, discounts: Discount[]): string[] {
  const allowed = new Set((Array.isArray(s.allowed_discounts) ? s.allowed_discounts : []).map((n) => String(n).trim().toLowerCase()));
  const over = s.review_over_pct ?? 10;
  const reasons: string[] = [];
  for (const d of discounts) {
    if (!allowed.has(d.name.trim().toLowerCase())) reasons.push(`"${d.name}" is not on the allowed list`);
    if (d.pct !== null && d.pct > over) reasons.push(`"${d.name}" is ${d.pct}% (over ${over}%)`);
    if (d.pct === 100) reasons.push(`"${d.name}" is 100%, a comp`);
  }
  return [...new Set(reasons)];
}

/** Every 30 minutes: each venue's new paid sales and their discounts, from Square. Flags go to the store. */
export async function watch(ctx: CompCtx) {
  const s = ctx.settings, list = venues(s);
  let read = 0, flagged = 0, skipped = 0;
  for (const v of list) {
    const wm = await ctx.store.get<Watermark>("watermark", v.square_location_id);
    const begin = new Date(wm ? Date.parse(wm.since) - OVERLAP_MS : ctx.now.getTime() - FIRST_RUN_MS).toISOString();
    const end = ctx.now.toISOString();
    let cursor: string | undefined, pages = 0, last: string | undefined;
    do {
      const page = await payments(ctx, v.square_location_id, begin, end, cursor);
      pages++;
      for (const p of page.rows) {
        if (!Number.isFinite(Date.parse(p.created_at))) { skipped++; continue; }
        last = p.created_at;
        if (!PAID.has(p.status) || typeof p.order_id !== "string" || !ORDER_ID.test(p.order_id)) { skipped++; continue; }
        if (await ctx.store.get("orders", p.order_id)) continue;
        const o = await order(ctx, p.order_id);
        const discounts = discountsOf(o);
        const reasons = flagsFor(s, discounts);
        const when = o.created_at && Number.isFinite(Date.parse(o.created_at)) ? o.created_at : p.created_at;
        const rec: OrderRecord = { venue: v.name, order_id: p.order_id, created: when, day: localDay(when, s.utc_offset_hours),
          discount_dollars: round(discounts.reduce((a, d) => a + d.dollars, 0)), discounts, flagged: reasons.length > 0, reasons,
          team_member_id: p.team_member_id ? cut(p.team_member_id, 80) : undefined, checked: ctx.now.toISOString() };
        await ctx.store.put("orders", p.order_id, rec);
        read++;
        if (rec.flagged) { flagged++; await ctx.store.put("flags", p.order_id, rec); }
      }
      cursor = page.cursor;
    } while (cursor && pages < MAX_PAGES);
    // Finished: the window is done. Cut short by the page limit: resume after the last payment read.
    const since = cursor ? (last ?? begin) : end;
    await ctx.store.put("watermark", v.square_location_id, { since } satisfies Watermark);
    if (cursor) ctx.log(`watch: ${v.name} has more sales than one run reads; the next run carries on from ${since}`);
  }
  ctx.log(`watch: ${read} sales read, ${flagged} flagged, ${skipped} skipped`);
  return { venues: list.length, read, flagged, skipped };
}

/** Daily: yesterday's sales, discounted sales, flags and discount dollars per venue. Reads the store only. */
export async function report(ctx: CompCtx): Promise<DailyReport> {
  const s = ctx.settings, list = venues(s);
  const day = localDay(new Date(ctx.now.getTime() - 24 * H).toISOString(), s.utc_offset_hours);
  const sales = Object.values(await ctx.store.list<OrderRecord>("orders")).filter((r) => r.day === day);
  const rows = list.map((v) => {
    const mine = sales.filter((r) => r.venue === v.name);
    return { venue: v.name, orders: mine.length, discounted: mine.filter((r) => r.discount_dollars > 0).length,
      flagged: mine.filter((r) => r.flagged).length, discount_dollars: round(mine.reduce((a, r) => a + r.discount_dollars, 0)) };
  });
  const out: DailyReport = { day, venues: rows, written: ctx.now.toISOString() };
  await ctx.store.put("daily", day, out);
  ctx.log(`report: ${day}, ${rows.reduce((a, r) => a + r.flagged, 0)} flagged sales`);
  return out;
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { watch, report };
