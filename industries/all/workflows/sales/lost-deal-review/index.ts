// The lost-deal review workflow's three crons. Each is deterministic: it reads, drafts a record in the store, or queues a
// re-open for approval. It never changes a deal on its own. Judgment (why a deal was really lost, what to change) belongs
// to the owner, with the agent skill in SKILL.md helping them read the records.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Deal, Review, Rollup, Settings } from "./types.ts";
import { DAY, keyOf, round2 } from "./types.ts";
import * as gohighlevel from "./adapters/gohighlevel.ts";

type C = Ctx<Settings>;
const PAGE_CAP = 2000; // the adapter reads at most 20 pages of 100

const reasonOf = (d: { lost_reason_id?: string }, names: Record<string, string>) =>
  d.lost_reason_id ? (names[d.lost_reason_id] ?? "reason not in the reason list") : "no reason recorded";
const reasonMap = async (ctx: C) => (await ctx.store.get<Record<string, string>>("reasons", "current")) ?? {};

/** Every 6 hours: lost deals and their reasons. A deal that is no longer lost is marked gone, not deleted. */
export async function intake(ctx: C) {
  const names = await gohighlevel.lostReasons(ctx);
  await ctx.store.put("reasons", "current", names);
  const lost = await gohighlevel.deals(ctx, "lost");
  let added = 0;
  const seen = new Set<string>();
  for (const d of lost) {
    const k = keyOf(d.id);
    seen.add(k);
    if (!(await ctx.store.get("lost-deals", k))) added++;
    await ctx.store.put("lost-deals", k, { ...d, seen: ctx.now.toISOString() });
  }
  if (lost.length < PAGE_CAP) {
    for (const [k, d] of Object.entries(await ctx.store.list<any>("lost-deals"))) {
      if (!seen.has(k) && !d.gone) await ctx.store.put("lost-deals", k, { ...d, gone: ctx.now.toISOString() });
    }
  } else ctx.log("intake: lost deals reached the read cap, so no deal was marked gone this run");
  ctx.log(`intake: ${lost.length} lost, ${added} new`);
  return { lost: lost.length, added };
}

/** Every 6 hours: a review record for each new lost deal, and a queued re-open for deals lost to a nurture reason. */
export async function review(ctx: C) {
  const names = await reasonMap(ctx);
  const within = (ctx.settings.nurture_within_days ?? 90) * DAY;
  const nurture = new Set(ctx.settings.nurture_reason_ids ?? []);
  let drafted = 0, pending = 0;
  for (const d of Object.values(await ctx.store.list<any>("lost-deals"))) {
    if (d.gone) continue;
    const k = keyOf(d.id);
    if (!(await ctx.store.get("reviews", k))) {
      const rv: Review = { deal_id: d.id, name: d.name, value: d.value, lost_at: d.changed_at, reason: reasonOf(d, names),
                           status: "to-review", drafted: ctx.now.toISOString() };
      await ctx.store.put("reviews", k, rv);
      drafted++;
    }
    const lostAt = Date.parse(d.changed_at);
    if (d.lost_reason_id && nurture.has(d.lost_reason_id) && Number.isFinite(lostAt) && ctx.now.getTime() - lostAt <= within) {
      await gohighlevel.queueReopen(ctx, d as Deal); // queue() returns the existing approval on a re-run
      pending++;
    }
  }
  ctx.log(`review: ${drafted} drafted, ${pending} re-open(s) pending approval`);
  return { drafted, reopen_pending: pending };
}

/** Weekly (Monday 8 or 9 am in eastern Australia): the lost and won counts and the top lost reasons over the window. Drafted only. */
export async function rollup(ctx: C): Promise<Rollup> {
  const windowDays = ctx.settings.rollup_days ?? 90;
  const since = ctx.now.getTime() - windowDays * DAY;
  const names = await reasonMap(ctx);
  const inWindow = (d: { changed_at: string }) => { const t = Date.parse(d.changed_at); return Number.isFinite(t) && t >= since; };
  const lost = Object.values(await ctx.store.list<any>("lost-deals")).filter((d) => !d.gone && inWindow(d));
  const won = (await gohighlevel.deals(ctx, "won")).filter(inWindow);
  const tally = new Map<string, { count: number; value: number }>();
  let noReason = 0;
  for (const d of lost) {
    const r = reasonOf(d, names);
    if (r === "no reason recorded") noReason++;
    const t = tally.get(r) ?? { count: 0, value: 0 };
    t.count++; t.value += d.value;
    tally.set(r, t);
  }
  const top = [...tally.entries()].sort((a, b) => b[1].count - a[1].count || b[1].value - a[1].value).slice(0, 5)
    .map(([reason, t]) => ({ reason, count: t.count, value: round2(t.value) }));
  const out: Rollup = {
    day: ctx.now.toISOString().slice(0, 10), window_days: windowDays, lost: lost.length,
    lost_value: round2(lost.reduce((a, d) => a + Number(d.value || 0), 0)), won: won.length,
    win_rate: lost.length + won.length ? round2((won.length / (won.length + lost.length)) * 100) : null, // a percentage
    no_reason: noReason, top_reasons: top,
  };
  await ctx.store.put("rollups", out.day, out);
  ctx.log(`rollup: ${out.lost} lost, ${out.won} won over ${windowDays} days`);
  return out;
}

export const CRONS: Record<string, (ctx: C) => Promise<unknown>> = { intake, review, rollup };
