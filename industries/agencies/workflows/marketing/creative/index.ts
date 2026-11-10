// The creative test reader's two crons. Each reads and queues; nothing launches, spends or pauses without approval.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { insights, activeAdIds, pauseAct } from "./adapters/meta-ads.ts";
import type { Settings, Snapshot } from "./types.ts";

/** Every 6 hours: read how each ad is doing and keep the snapshot. */
export async function monitor(ctx: Ctx<Settings>) {
  const rows = await insights(ctx);
  const snap: Snapshot = { at: ctx.now.toISOString(), rows };
  await ctx.store.put("snapshot", "latest", snap);
  ctx.log(`monitor: ${rows.length} ads read`);
  return { ads: rows.length };
}

/** Nightly: an active ad that has spent enough with a CTR under the floor is queued for a pause. A person approves it. */
export async function review(ctx: Ctx<Settings>) {
  const snap = await ctx.store.get<Snapshot>("snapshot", "latest");
  if (!snap?.rows.length) return { queued: 0, reason: "no snapshot yet" };
  const minSpend = ctx.settings.min_spend ?? 100, floor = ctx.settings.min_ctr_percent ?? 0.5, cap = ctx.settings.max_pauses_per_run ?? 5;
  const active = await activeAdIds(ctx);
  const losers = snap.rows.filter((r) => active.has(r.ad_id) && r.spend >= minSpend && r.ctr < floor).slice(0, cap);
  for (const r of losers) {
    await ctx.queue(pauseAct(r.ad_id), `Pause ${r.ad_name ?? r.ad_id}: spent $${r.spend.toFixed(2)}, CTR ${r.ctr}% under ${floor}%`);
  }
  ctx.log(`review: ${losers.length} pause(s) queued for approval`);
  return { queued: losers.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { monitor, review };
