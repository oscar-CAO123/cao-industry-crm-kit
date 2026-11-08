// The labour alerts workflow's two crons. Each reads Deputy or the store and records what it finds. Neither sends,
// changes a roster or changes a rule, so no live operation is used here.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { dayKey, localDay, round, type Alert, type LabourCtx, type Settings, type Snapshot, type Venue } from "./types.ts";
import { labourCost, sales } from "./adapters/deputy.ts";

/** Checks the venue list from settings before any network call. */
export function venues(s: Settings): Venue[] {
  if (!Number.isFinite(s.utc_offset_hours) || s.utc_offset_hours < -12 || s.utc_offset_hours > 14) throw new Error("labour: utc_offset_hours out of range");
  if (!Array.isArray(s.venues) || !s.venues.length) throw new Error("labour: settings.venues is empty");
  return s.venues.map((v) => {
    if (!Number.isInteger(v.deputy_area) || v.deputy_area <= 0) throw new Error(`labour: ${String(v.name).slice(0, 40)}: deputy_area must be a whole number`);
    if (!(v.labour_target_pct > 0 && v.labour_target_pct <= 100)) throw new Error(`labour: ${String(v.name).slice(0, 40)}: labour_target_pct must be above 0 and at most 100`);
    return { ...v, name: String(v.name).slice(0, 80) };
  });
}

/** Every 30 minutes: each venue's labour cost and sales for today, from Deputy. */
export async function pull(ctx: LabourCtx) {
  const offset = ctx.settings.utc_offset_hours, day = localDay(ctx.now, offset);
  const list = venues(ctx.settings);
  for (const v of list) {
    const snap: Snapshot = { venue: v.name, area: v.deputy_area, day, labour_cost: await labourCost(ctx, v.deputy_area, day),
      sales: await sales(ctx, v.deputy_area, day, offset), pulled: ctx.now.toISOString() };
    await ctx.store.put("labour", dayKey(v.deputy_area, day), snap);
  }
  ctx.log(`pull: ${list.length} venues for ${day}`);
  return { venues: list.length, day };
}

/** Hourly: labour as a share of sales for each venue; an alert record is kept open while the share is over target. */
export async function check(ctx: LabourCtx) {
  const s = ctx.settings, day = localDay(ctx.now, s.utc_offset_hours), min = s.min_sales ?? 200;
  let open = 0;
  for (const v of venues(s)) {
    const key = dayKey(v.deputy_area, day);
    const snap = await ctx.store.get<Snapshot>("labour", key);
    const prev = await ctx.store.get<Alert>("alerts", key);
    const base = { venue: v.name, area: v.deputy_area, day, target_pct: v.labour_target_pct, checked: ctx.now.toISOString() };
    let alert: Alert;
    if (!snap || snap.sales < min) alert = { ...base, labour_pct: null, status: "waiting-for-data" };
    else {
      const pct = round(snap.labour_cost / snap.sales * 100, 1);
      const over = pct > v.labour_target_pct;
      alert = { ...base, labour_pct: pct, status: over ? "open" : "ok",
        ...(over ? { raised: prev?.status === "open" && prev.raised ? prev.raised : ctx.now.toISOString() } : {}) };
    }
    await ctx.store.put("alerts", key, alert);
    if (alert.status === "open") open++;
  }
  ctx.log(`check: ${open} open alerts for ${day}`);
  return { open };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pull, check };
