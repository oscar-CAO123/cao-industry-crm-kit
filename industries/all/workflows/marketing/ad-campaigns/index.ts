// The ad-campaigns workflow's three crons. plan checks each new campaign plan. build walks each ready plan through the Meta
// create steps, one approval at a time, and each step uses the id the step before it created. review reads the last seven
// days per campaign for the owner. No cron creates, sends or switches anything on: creates wait for a person's approval.
import type { Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import { type CampaignPlan, type Settings, type Step, STEPS, NUM, keyOf, planProblem, setupProblem, POST_ID } from "./types.ts";
import { createAct, campaignResults } from "./adapters/meta-ads.ts";

/** Every 30 minutes: check each planned campaign. A plan that passes is ready to build; one that fails is skipped with the reason. */
export async function plan(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`ad-campaigns: ${setup}`);
  const todo = Object.entries(await ctx.store.list<CampaignPlan>("campaigns"))
    .filter(([key, p]) => p.status === "planned" && POST_ID.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, s.plan_limit_per_run ?? 5);
  let ready = 0, skipped = 0;
  for (const [key, p] of todo) {
    const why = planProblem(p, s);
    if (why) { await ctx.store.put("campaigns", key, { ...p, status: "skipped", reason: why }); skipped++; continue; }
    await ctx.store.put("campaigns", key, { ...p, status: "ready", reason: undefined });
    ready++;
  }
  ctx.log(`plan: ${ready} ready, ${skipped} skipped`);
  return { ready, skipped };
}

/** Every 15 minutes: move each ready plan on by one approval. Queues the next create only once the one before it is done. */
export async function build(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`ad-campaigns: ${setup}`);
  const todo = Object.entries(await ctx.store.list<CampaignPlan>("campaigns"))
    .filter(([, p]) => p.status === "ready" || p.status === "building")
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, s.plan_limit_per_run ?? 5);
  const counts = { built: 0, waiting: 0, blocked: 0, rejected: 0 };
  for (const [key, p] of todo) {
    const next = await advance(ctx, key, p);
    await ctx.store.put("campaigns", key, next);
    if (next.status === "built") counts.built++;
    else if (next.status === "blocked") counts.blocked++;
    else if (next.status === "rejected") counts.rejected++;
    else counts.waiting++;
  }
  ctx.log(`build: ${counts.built} built, ${counts.waiting} waiting, ${counts.blocked} blocked, ${counts.rejected} rejected`);
  return counts;
}

/** Walk the steps in order. Stops at the first one still waiting on an approval, or queues the first one not yet queued. */
async function advance(ctx: Ctx<Settings>, key: string, p: CampaignPlan): Promise<CampaignPlan> {
  const ids = { ...(p.ids ?? {}) }, approvals = { ...(p.approvals ?? {}) };
  const stop = (status: CampaignPlan["status"], reason?: string) => ({ ...p, status, reason, ids, approvals });
  for (const step of STEPS as Step[]) {
    if (NUM.test(ids[step] ?? "")) continue;
    const aid = approvals[step];
    if (aid) {
      const ap = await ctx.store.get<Approval>("approvals", aid);
      if (!ap) return stop("blocked", `${step}: its approval ${aid} is missing`);
      if (ap.status === "done") {
        const id = String(ap.results?.at(-1)?.ref?.id ?? "");
        if (!NUM.test(id)) return stop("blocked", `${step}: the platform returned no id`);
        ids[step] = id;
        continue;
      }
      if (ap.status === "pending" || ap.status === "running") return stop("building");
      if (ap.status === "rejected") return stop("rejected", `${step} was rejected`);
      return stop("blocked", `${step}: ${ap.status}${ap.error ? `, ${ap.error}` : ""}`);
    }
    // The plan may have been edited since plan() passed it: check it again before anything is queued.
    const why = planProblem(p, ctx.settings);
    if (why) return stop("blocked", `plan no longer passes: ${why}`);
    const act = createAct(ctx.settings, p, step, ids, keyOf(`${key}:${step}`));
    approvals[step] = await ctx.queue(act, act.summary);
    return stop("building");
  }
  return stop("built");
}

/** Daily: read the last seven days per campaign and keep them for the owner's review. Reads only. */
export async function review(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`ad-campaigns: ${setup}`);
  const rows = await campaignResults(ctx, s);
  await ctx.store.put("reviews", "latest", { at: ctx.now.toISOString(), days: 7, rows });
  ctx.log(`review: ${rows.length} campaigns`);
  return { campaigns: rows.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { plan, build, review };
