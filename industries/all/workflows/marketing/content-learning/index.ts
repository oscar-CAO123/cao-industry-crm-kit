// The content-learning workflow's two crons. pull reads ad results, running ads and recent Instagram posts into the
// performance store. score reads that snapshot, scores every ad and post, writes the plan that feeds the next brief, and
// queues a pause for a running ad over the cost-per-lead limit. Nothing here pauses an ad: a pause waits for a person.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { AdPerf, PostPerf, Scored, Scorecard, Settings, Snapshot } from "./types.ts";
import { setupProblem, median, money } from "./types.ts";
import { meta } from "./adapters/meta-ads.ts";

/** Daily, 21:30 UTC (7 or 8 am in eastern Australia): read ad results, running ads and recent posts into the store. Reads only. */
export async function pull(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`content-learning: ${setup}`);
  const period = s.window ?? "last_30d";
  let ads: AdPerf[] = [], posts: PostPerf[] = [], partial = false;
  if (s.meta.ad_account_id) {
    const account = String(s.meta.ad_account_id);
    const perf = await meta.adPerformance(ctx, account, period);
    const live = await meta.runningAdIds(ctx, account);
    const running = new Set(live.ids);
    ads = perf.ads.map((a) => ({ ...a, running: running.has(a.id) }));
    partial = partial || perf.truncated || live.truncated;
  }
  if (s.meta.instagram_user_id) {
    const got = await meta.instagramPosts(ctx, String(s.meta.instagram_user_id), Math.min(s.history_limit ?? 25, 50));
    posts = got.posts;
    partial = partial || got.partial;
  }
  const snap: Snapshot = { at: ctx.now.toISOString(), window: period, ads, posts, partial };
  await ctx.store.put("performance", "latest", snap);
  ctx.log(`pull: ${ads.length} ads, ${posts.length} posts${partial ? " (partial)" : ""}`);
  return { ads: ads.length, posts: posts.length, partial };
}

/** Ads: working means cost per lead at or under the owner's limit, or at or under the median when no limit is set. */
export function scoreAds(ads: AdPerf[], s: Settings): Scored[] {
  const min = s.min_spend_before_judging ?? 100;
  const bar = s.max_cost_per_lead ?? median(ads.filter((a) => a.spend >= min && a.cost_per_lead !== null).map((a) => a.cost_per_lead as number));
  return ads.map((a) => {
    const name = a.name || a.id;
    const measure = `${money(a.spend)} spent, ${a.leads} lead${a.leads === 1 ? "" : "s"}${a.cost_per_lead !== null ? `, ${money(a.cost_per_lead)} per lead` : ""}`;
    if (a.spend < min) return { kind: "ad", id: a.id, name, band: "too early", measure, rank: 0 };
    const working = a.cost_per_lead !== null && bar !== null && a.cost_per_lead <= bar;
    return { kind: "ad", id: a.id, name, band: working ? "working" : "not working", measure,
      rank: a.cost_per_lead === null ? 0 : -a.cost_per_lead };
  });
}

/** Posts: working means an engagement rate at or above the median of the posts that reached the minimum. */
export function scorePosts(posts: PostPerf[], s: Settings): Scored[] {
  const min = s.min_reach_before_judging ?? 200;
  const bar = median(posts.filter((p) => p.reach >= min && p.engagement_rate !== null).map((p) => p.engagement_rate as number));
  return posts.map((p) => {
    const name = `Instagram post ${p.id}`;
    const interactions = p.likes + p.comments + p.saves + p.shares;
    const measure = `${p.reach} reached, ${interactions} interactions${p.engagement_rate !== null ? `, ${(p.engagement_rate * 100).toFixed(1)}% engagement` : ""}`;
    if (p.reach < min || p.engagement_rate === null) return { kind: "instagram", id: p.id, name, band: "too early", measure, rank: 0 };
    const working = bar !== null && p.engagement_rate >= bar;
    return { kind: "instagram", id: p.id, name, band: working ? "working" : "not working", measure, rank: p.engagement_rate };
  });
}

/** Daily, 22:00 UTC (8 or 9 am in eastern Australia): score the last snapshot, write the plan, queue pauses for approval. */
export async function score(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`content-learning: ${setup}`);
  const snap = await ctx.store.get<Snapshot>("performance", "latest");
  if (!snap) {
    ctx.log("score: no snapshot yet, pull has not run");
    return { scored: 0, queued: 0, reason: "no snapshot yet" };
  }
  const items = [...scoreAds(snap.ads, s), ...scorePosts(snap.posts, s)];

  const limit = s.max_cost_per_lead, min = s.min_spend_before_judging ?? 100, cap = s.pauses_per_run ?? 5;
  const pending: string[] = [];
  if (limit !== undefined) {
    // An over-limit period runs from the first score that finds the ad over the limit until a score that does not.
    // Its pause is keyed by the day the period began: a rejected pause stays rejected for that period, and an ad that was
    // paused or stopped and then runs over the limit again starts a new period with its own approval.
    const since = (await ctx.store.get<Record<string, string>>("pauses", "since")) ?? {};
    const over = snap.ads.filter((a) => a.running && a.spend >= min && (a.leads === 0 || (a.cost_per_lead ?? Infinity) > limit))
      .sort((x, y) => y.spend - x.spend);
    const next: Record<string, string> = {};
    for (const a of over) next[a.id] = since[a.id] ?? snap.at.slice(0, 10);
    await ctx.store.put("pauses", "since", next);
    for (const a of over) {
      if (pending.length >= cap) break;
      const why = a.leads === 0 ? `${money(a.spend)} spent, no leads` : `${money(a.cost_per_lead as number)} per lead, over the ${money(limit)} limit`;
      pending.push(await ctx.queue(meta.pauseAct(a.id, why, next[a.id]), `Pause "${a.name || a.id}": ${why} (${snap.window})`));
    }
  }

  const pick = (kind: Scored["kind"], band: Scored["band"], best: boolean) =>
    items.filter((i) => i.kind === kind && i.band === band)
      .sort((x, y) => best ? y.rank - x.rank : x.rank - y.rank).slice(0, 3);
  const card: Scorecard = {
    at: ctx.now.toISOString(), from_snapshot: snap.at, partial: snap.partial, items,
    plan: {
      make_more: [...pick("ad", "working", true), ...pick("instagram", "working", true)],
      fix_or_stop: [...pick("ad", "not working", false), ...pick("instagram", "not working", false)],
      too_early: items.filter((i) => i.band === "too early").length,
    },
    pauses_awaiting_approval: pending,
    not_covered: "Links from content to enquiries, leads or sales are not read; the business's sales records decide whether a winner pays.",
  };
  await ctx.store.put("scores", "latest", card);
  ctx.log(`score: ${items.length} scored, ${pending.length} pause(s) awaiting approval`);
  return { scored: items.length, queued: pending.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pull, score };
