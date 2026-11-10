// The missed-call text-back workflow's three crons. Each reads, drafts an internal note, or queues a text for approval.
// None sends. A person approves every text to a caller in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type MissedCall, type Settings, checkSettings, lookbackMs, masked, textBody } from "./types.ts";
import { missedCalls, textAct } from "./adapters/justcall.ts";
import { gohighlevel } from "./adapters/gohighlevel.ts";

/** Every 10 minutes: record each missed call on the business number since the lookback. Read only. */
export async function intake(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const since = new Date(ctx.now.getTime() - lookbackMs(ctx.settings));
  let added = 0;
  for (const c of await missedCalls(ctx, since)) {
    if (await ctx.store.get<MissedCall>("calls", c.key)) continue;     // seen before: intake never records it twice
    await ctx.store.put("calls", c.key, c.caller ? c : { ...c, closed: "no valid caller number" });
    if (c.caller) added++;
  }
  ctx.log(`intake: ${added} missed calls recorded`);
  return { added };
}

/** Every 10 minutes: queue one text back to each recorded missed caller. Queued for approval, never sent here. */
export async function textback(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  let queued = 0;
  for (const call of Object.values(await ctx.store.list<MissedCall>("calls"))) {
    if (call.texted || call.closed || !call.caller) continue;
    if (ctx.now.getTime() - Date.parse(call.received) > lookbackMs(ctx.settings)) {
      await ctx.store.put("calls", call.key, { ...call, closed: "older than the lookback when first seen" });
      continue;
    }
    const when = call.received.replace("T", " ").slice(0, 16);
    await ctx.queue(textAct(ctx.settings, call.caller, textBody(ctx.settings), `textback:${call.key}`),
      `Text back ${masked(call.caller)}: missed call at ${when} UTC`);
    await ctx.store.put("calls", call.key, { ...call, texted: ctx.now.toISOString() });
    queued++;
  }
  ctx.log(`textback: ${queued} queued for approval`);
  return { queued };
}

/** Every 15 minutes: one internal note per missed call on the caller's GoHighLevel contact. Drafts only. */
export async function logCalls(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  if (!ctx.settings.gohighlevel) {
    ctx.log("log: no gohighlevel setting, nothing written");
    return { logged: 0 };
  }
  let logged = 0, failed = 0;
  for (const call of Object.values(await ctx.store.list<MissedCall>("calls"))) {
    if (call.logged || call.closed || !call.caller) continue;
    try {
      const contact = call.contact ?? await gohighlevel.contactFor(ctx, call.caller);
      await gohighlevel.note(ctx, contact, `Missed call from ${call.caller} at ${call.received} UTC. A text back waits for approval in the CRM shell.`);
      await ctx.store.put("calls", call.key, { ...call, contact, logged: ctx.now.toISOString() });
      logged++;
    } catch (e) {
      failed++;
      ctx.log(`log: skipped one missed call (${(e as Error).message})`);
    }
  }
  ctx.log(`log: ${logged} noted, ${failed} failed`);
  return { logged, failed };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, textback, log: logCalls };
