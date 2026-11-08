// The marketing-data workflow's two crons. pull reads campaign numbers from the firm's Meta ad account into the store.
// review reads what pull stored and writes the report the owner reads. Nothing here changes an ad or sends anything:
// no live operation is mapped for this job, so the runtime would refuse a queue of one.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Report, Settings, Snapshot } from "./types.ts";
import { money, setupProblem, windowOf } from "./types.ts";
import { meta } from "./adapters/meta-ads.ts";

/** Daily, 21:00 UTC (7 or 8 am in eastern Australia): read campaign numbers for the window into the store. Reads only. */
export async function pull(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`marketing-data: ${setup}`);
  const window = windowOf(s);
  const ins = await meta.campaignInsights(ctx, String(s.meta.ad_account_id), window);
  const snap: Snapshot = { at: ctx.now.toISOString(), window, truncated: ins.truncated, rows: ins.rows };
  await ctx.store.put("marketing", "latest", snap);
  ctx.log(`pull: ${ins.rows.length} campaigns, ${window}${snap.truncated ? " (partial list)" : ""}`);
  return { campaigns: ins.rows.length, truncated: snap.truncated };
}

/** Daily, 22:00 UTC (8 or 9 am in eastern Australia): write the report from the stored snapshot. Writes to the store only. */
export async function review(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`marketing-data: ${setup}`);
  const snap = await ctx.store.get<Snapshot>("marketing", "latest");
  if (!snap) {
    ctx.log("review: no snapshot yet, pull has not run");
    return { written: false, reason: "no snapshot yet" };
  }
  const spend = snap.rows.reduce((n, r) => n + r.spend, 0);
  const leads = snap.rows.reduce((n, r) => n + r.leads, 0);
  const report: Report = {
    at: ctx.now.toISOString(), window: snap.window, currency: s.currency ?? "AUD", from_snapshot: snap.at,
    total_spend: Math.round(spend * 100) / 100, total_leads: leads,
    blended_cost_per_lead: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null,
    campaigns: [...snap.rows].sort((a, b) => b.spend - a.spend),
    partial: snap.truncated,
    not_covered: "Website, search, lead and practice-system numbers are not read by this job yet. Return on spend needs the firm's own records.",
  };
  await ctx.store.put("reports", "latest", report);
  ctx.log(`review: ${snap.rows.length} campaigns, ${money(report.total_spend)} spend, ${leads} leads`);
  return { written: true, campaigns: snap.rows.length, leads };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pull, review };
