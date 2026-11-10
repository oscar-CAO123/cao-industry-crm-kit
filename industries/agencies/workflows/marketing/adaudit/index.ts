// The daily ad audit's two crons. Each reads and queues; nothing reaches an ad account without a person's approval.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { CampaignRow, Finding, Settings } from "./types.ts";
import { campaignInsights, queuePause } from "./adapters/meta-ads.ts";

/** Refuse to run without the two settings the audit cannot do without: a result list, and the account timezone. */
function requireSettings(ctx: Ctx<Settings>) {
  if (!ctx.settings.result_action_types?.length) throw new Error("adaudit: result_action_types is empty, so results cannot be counted");
  if (!ctx.settings.timezone) throw new Error("adaudit: timezone is missing (the ad accounts' IANA zone, for example Australia/Sydney)");
}

/** The calendar day before `now` in a timezone, as YYYY-MM-DD. */
export function yesterdayIn(now: Date, timeZone: string): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** 22:00 UTC: read yesterday's campaign results for every Meta account in settings and keep the snapshot. */
export async function pull(ctx: Ctx<Settings>) {
  requireSettings(ctx);
  let rows = 0;
  for (const account of ctx.settings.meta_accounts ?? []) {
    const got = await campaignInsights(ctx, account);
    for (const r of got) await ctx.store.put("snapshots", `${r.account}:${r.campaign_id}:${r.date}`, r);
    rows += got.length;
  }
  ctx.log(`pull: ${rows} campaign rows`);
  return { rows };
}

/** 22:10 UTC: check the snapshot against the thresholds, store the findings, and queue pauses for approval. */
export async function audit(ctx: Ctx<Settings>) {
  requireSettings(ctx);
  const t = ctx.settings.thresholds;
  const expected = yesterdayIn(ctx.now, ctx.settings.timezone);
  const all = Object.values(await ctx.store.list<CampaignRow>("snapshots"));
  const latest = all.reduce((m, r) => (r.date > m ? r.date : m), "");   // only the newest day, so an old day is never queued twice
  if (latest !== expected) {
    // The pull did not deliver yesterday: stop, record why, and queue nothing built on older data.
    const why = `newest snapshot is ${latest || "none"}, not ${expected}: the pull did not finish, so nothing was audited or queued`;
    await ctx.store.put("audits", expected, { date: expected, findings: [], stopped: why });
    ctx.log(`audit stopped: ${why}`);
    return { stopped: why, findings: 0, queued: 0 };
  }
  const rows = all.filter((r) => r.date === latest);
  const findings: Finding[] = [];
  let queued = 0;
  for (const r of rows) {
    if (r.impressions > 0 && r.frequency > t.frequency_max) findings.push({ account: r.account, campaign_id: r.campaign_id, kind: "frequency", detail: `frequency ${r.frequency.toFixed(2)} is above ${t.frequency_max}` });
    if (r.impressions >= 1000 && r.ctr < t.ctr_min_pct) findings.push({ account: r.account, campaign_id: r.campaign_id, kind: "ctr", detail: `CTR ${r.ctr.toFixed(2)}% is below ${t.ctr_min_pct}%` });
    if (r.spend >= t.pause_spend_without_results_usd && r.results === 0) {
      findings.push({ account: r.account, campaign_id: r.campaign_id, kind: "spend-without-results", detail: `spent $${r.spend.toFixed(2)} with no results` });
      await queuePause(ctx, r, `spent $${r.spend.toFixed(2)} yesterday with no results`);
      queued++;
    }
  }
  for (const account of ctx.settings.meta_accounts ?? []) {
    const budget = ctx.settings.daily_budget_usd?.[account];
    if (!budget) continue;
    const spent = rows.filter((r) => r.account === account).reduce((n, r) => n + r.spend, 0);
    const pct = (spent / budget) * 100;
    if (pct < t.pacing_min_pct || pct > t.pacing_max_pct) findings.push({ account, kind: "pacing", detail: `spent ${pct.toFixed(0)}% of the $${budget} daily budget` });
  }
  await ctx.store.put("audits", latest, { date: latest, findings });
  ctx.log(`audit: ${findings.length} findings, ${queued} pauses queued`);
  return { findings: findings.length, queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pull, audit };
