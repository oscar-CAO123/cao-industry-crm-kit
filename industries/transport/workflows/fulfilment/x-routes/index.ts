// The route planning workflow's two crons. Each reads and drafts; the plan cron queues a dispatch for approval.
// Judgment (a stop with a bad address, a team's constraints the platform cannot hold) belongs to the agent skill in SKILL.md.
import crypto from "node:crypto";
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, Stop } from "./types.ts";
import { ID, routeEndOf, storeKey } from "./types.ts";
import { tasksSince, routePlansIn, queueDispatch } from "./adapters/onfleet.ts";

const HOUR = 36e5;
const OVERLAP = 30 * 60e3;   // re-read the last half hour so a task created mid-run is never missed

/** Every 15 minutes: read the platform's tasks since the last run and keep them as stops. Drafts a list of stops with no address. */
export async function intake(ctx: Ctx<Settings>) {
  const cursor = await ctx.store.get<{ at: number }>("cursor", "intake");
  const from = cursor?.at ? cursor.at - OVERLAP : ctx.now.getTime() - (ctx.settings.lookback_hours ?? 24) * HOUR;
  const stops = await tasksSince(ctx, from);
  for (const s of stops) await ctx.store.put("stops", storeKey(s.id), s satisfies Stop);
  const noAddress = stops.filter((s) => !s.address).map((s) => s.id);
  await ctx.store.put("drafts", "no-address", { at: ctx.now.toISOString(), ids: noAddress });
  await ctx.store.put("cursor", "intake", { at: ctx.now.getTime() });
  ctx.log(`intake: ${stops.length} read, ${noAddress.length} without an address`);
  return { read: stops.length, no_address: noAddress.length };
}

/** Every 30 minutes: for each team, count stops not yet in a route. Drafts the plan note and queues one dispatch per team per day. */
export async function plan(ctx: Ctx<Settings>) {
  const routeEnd = ctx.settings.route_end === undefined ? "teams://DEFAULT" : routeEndOf(ctx.settings.route_end);
  const day = ctx.now.toISOString().slice(0, 10);
  const unrouted = Object.values(await ctx.store.list<Stop>("stops")).filter((s) => !s.routed && s.address);
  const now = ctx.now.getTime();
  let queued = 0; // dispatch requests made; a request already queued for the same day is reused, not added
  // The key is the day plus the exact set of unrouted stops, so a stop that arrives later the same day gets its own approval.
  const stopSet = crypto.createHash("sha256").update(unrouted.map((s) => s.id).sort().join(",")).digest("hex").slice(0, 16);
  for (const team of ctx.settings.teams ?? []) {
    if (!ID.test(team)) { ctx.log(`plan: skipped a team id that does not look like an Onfleet id`); continue; }
    const runs = (await routePlansIn(ctx, now - 12 * HOUR, now + 24 * HOUR)).filter((p) => p.team === team);
    await ctx.store.put("drafts", storeKey(`plan-${team}-${day}`), { at: ctx.now.toISOString(), team, unrouted: unrouted.length, runs_today: runs.length, route_end: routeEnd });
    if (!unrouted.length) continue;
    await queueDispatch(ctx, team, routeEnd, `dispatch:${team}:${day}:${stopSet}`,
      `Auto-dispatch team ${team}: ${unrouted.length} stops not yet in a route, routes end at ${routeEnd ?? "anywhere"}`);
    queued++;
  }
  ctx.log(`plan: ${queued} dispatch queued for approval`);
  return { queued, unrouted: unrouted.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, plan };
