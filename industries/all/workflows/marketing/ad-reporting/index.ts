// The ad-reporting workflow's two crons. pull reads the last 7 days of ad numbers and the ads running now. review reads
// what pull stored, writes the report, and queues a pause for any running ad over the owner's cost-per-lead limit.
// Nothing here pauses an ad: a pause waits in the approval queue until a person approves it.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Snapshot, Settings } from "./types.ts";
import { setupProblem } from "./types.ts";
import { meta } from "./adapters/meta-ads.ts";

/** Daily, 21:00 UTC (7 or 8 am in eastern Australia): read spend, leads and running ads into the spend store. Reads only. */
export async function pull(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`ad-reporting: ${setup}`);
  const account = String(s.meta.ad_account_id);
  const ins = await meta.adInsights(ctx, account);
  const act = await meta.activeAdIds(ctx, account);
  const snap: Snapshot = { at: ctx.now.toISOString(), window: "last_7d", truncated: ins.truncated || act.truncated, active: act.ids, rows: ins.rows };
  await ctx.store.put("spend", "latest", snap);
  ctx.log(`pull: ${ins.rows.length} ads with delivery, ${act.ids.length} running${snap.truncated ? " (partial list)" : ""}`);
  return { ads: ins.rows.length, running: act.ids.length, truncated: snap.truncated };
}

/** Daily, 22:00 UTC: write the report from the stored snapshot and queue pauses for running ads over the limit. */
export async function review(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`ad-reporting: ${setup}`);
  const snap = await ctx.store.get<Snapshot>("spend", "latest");
  if (!snap) {
    ctx.log("review: no snapshot yet, pull has not run");
    return { queued: 0, reason: "no snapshot yet" };
  }
  const running = new Set(snap.active);
  const min = s.min_spend_before_judging ?? 100, limit = s.max_cost_per_lead, cap = s.pauses_per_run ?? 10;
  const pending: string[] = [];
  if (limit !== undefined) {
    // An over-limit period runs from the first review that finds the ad over the limit until a review that does not.
    // Its pause is keyed by the day the period began: a rejected pause stays rejected for that period, and an ad that was
    // paused or stopped and then runs over the limit again starts a new period with its own approval.
    const since = (await ctx.store.get<Record<string, string>>("pauses", "since")) ?? {};
    const over = [...snap.rows].sort((a, b) => b.spend - a.spend)
      .filter((r) => running.has(r.ad_id) && r.spend >= min && (r.leads === 0 || r.spend / r.leads > limit));
    const next: Record<string, string> = {};
    for (const r of over) next[r.ad_id] = since[r.ad_id] ?? snap.at.slice(0, 10);
    await ctx.store.put("pauses", "since", next);
    for (const r of over) {
      if (pending.length >= cap) break;
      const why = r.leads === 0 ? `${money(r.spend)} spent, no leads` : `${money(r.spend / r.leads)} per lead, over the ${money(limit)} limit`;
      pending.push(await ctx.queue(meta.pauseAct(r.ad_id, why, next[r.ad_id]), `Pause "${r.ad_name || r.ad_id}": ${why} (last 7 days)`));
    }
  }
  const spend = snap.rows.reduce((n, r) => n + r.spend, 0), leads = snap.rows.reduce((n, r) => n + r.leads, 0);
  await ctx.store.put("reports", "latest", {
    at: ctx.now.toISOString(), window: snap.window, currency: s.currency ?? "AUD", from_snapshot: snap.at,
    total_spend: Math.round(spend * 100) / 100, total_leads: leads,
    blended_cost_per_lead: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null,
    ads: snap.rows.map(({ ad_id, ad_name, spend: sp, leads: ld, cost_per_lead }) => ({ ad_id, ad_name, spend: sp, leads: ld, cost_per_lead })),
    pauses_awaiting_approval: pending,
    partial: snap.truncated,
    not_covered: "Return on ad spend needs the business's sales records, which this job does not read.",
  });
  ctx.log(`review: ${snap.rows.length} ads reported, ${pending.length} pause(s) awaiting approval`);
  return { queued: pending.length, ads: snap.rows.length };
}

const money = (n: number) => `$${n.toFixed(2)}`;

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pull, review };
