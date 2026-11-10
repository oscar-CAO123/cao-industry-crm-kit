// The email flows workflow's three crons. Performance and review read and record; go-live only queues.
// Nothing here sends, changes a live flow, or touches a customer. A person approves every switch to live.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { klaviyo } from "./adapters/klaviyo.ts";
import type { FlowRow, ReadyFlow, Scorecard, Settings, Sprint } from "./types.ts";

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

/** Daily: every flow with its results over the timeframe, written to the scorecard. Reads only. */
export async function performance(ctx: Ctx<Settings>) {
  const k = ctx.settings.klaviyo;
  const target = k.target_conversion_rate ?? 0.02;
  const flows = await klaviyo.flows(ctx);
  const stats = await klaviyo.results(ctx);
  const rows: FlowRow[] = flows.map((f) => {
    const s = stats.get(f.id) ?? {};
    return { ...f, recipients: Number(s.recipients ?? 0), conversions: Number(s.conversions ?? 0),
      conversion_rate: Number(s.conversion_rate ?? 0), revenue: Number(s.conversion_value ?? 0) };
  });
  const card: Scorecard = { taken: ctx.now.toISOString(), timeframe: k.timeframe ?? "last_30_days", target, flows: rows };
  await ctx.store.put("scorecard", "latest", card);
  ctx.log(`performance: ${rows.length} flows`);
  return { flows: rows.length };
}

/** Weekly: open one sprint on the weakest live flow that is under target and has no sprint yet. Reads and records only. */
export async function review(ctx: Ctx<Settings>) {
  const card = await ctx.store.get<Scorecard>("scorecard", "latest");
  if (!card) return { opened: 0, reason: "no scorecard yet" };
  const min = ctx.settings.klaviyo.min_recipients ?? 500;
  const sprints = await ctx.store.list<Sprint>("sprints");
  const weakest = card.flows
    .filter((f) => f.status === "live" && f.recipients >= min && f.conversion_rate < card.target && !sprints[f.id])
    .sort((a, b) => a.conversion_rate - b.conversion_rate)[0];
  if (!weakest) { ctx.log("review: no live flow under target without a sprint"); return { opened: 0 }; }
  const action_ids = await klaviyo.actions(ctx, weakest.id);
  const sprint: Sprint = { flow_id: weakest.id, flow_name: weakest.name, opened: ctx.now.toISOString(), action_ids,
    reason: `${pct(weakest.conversion_rate)} conversion against a ${pct(card.target)} target, ${weakest.recipients} recipients in ${card.timeframe}` };
  await ctx.store.put("sprints", weakest.id, sprint);
  ctx.log(`review: sprint opened on ${weakest.name}`);
  return { opened: 1, flow: weakest.name };
}

/** Daily: queue a switch to live for each draft flow the owner has marked ready. Only ever queues. */
export async function goLive(ctx: Ctx<Settings>) {
  const ready = await ctx.store.list<ReadyFlow>("ready");
  const card = await ctx.store.get<Scorecard>("scorecard", "latest");
  let queued = 0;
  for (const r of Object.values(ready)) {
    const row = card?.flows.find((f) => f.id === r.flow_id);
    if (!row || !["draft", "manual"].includes(row.status)) continue; // already live, archived, or not in the account
    await ctx.queue(klaviyo.goLiveAct(row.id, row.name, r.marked), `Put flow "${row.name}" live, marked ready by ${r.marked_by}`);
    queued++;
  }
  ctx.log(`go-live: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { performance, review, "go-live": goLive };
