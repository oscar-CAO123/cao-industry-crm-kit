// The email marketing workflow's three crons. Each reads, drafts or queues. None of them sends, schedules, starts or
// pauses anything: a scheduled send and a flow change are only ever queued, and run when a person approves them.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { FlowChange, Newsletter, Settings } from "./types.ts";
import { keyOf, line, newsletterProblem, flowProblem, settingsProblem } from "./types.ts";
import * as mc from "./adapters/mailchimp.ts";
import * as kl from "./adapters/klaviyo.ts";

/** Daily: read recent sends and the flows that exist, and flag sends under the owner's targets. Changes nothing. */
export async function sync(ctx: Ctx<Settings>) {
  const s = ctx.settings, t = s.targets ?? { open_rate: null, click_rate: null };
  const now = ctx.now.toISOString();
  let sends = 0, under = 0, flows = 0;
  if (s.platforms.includes("mailchimp")) {
    for (const r of await mc.reports(ctx)) {
      const weak = (t.open_rate != null && (r.open_rate ?? 0) < t.open_rate) || (t.click_rate != null && (r.click_rate ?? 0) < t.click_rate);
      await ctx.store.put("reports", keyOf(`mailchimp:${r.id}`), { platform: "mailchimp", ...r, below_target: weak, read: now });
      sends++; if (weak) under++;
    }
    for (const a of await mc.automations(ctx)) { await ctx.store.put("flows", keyOf(`mailchimp:${a.id}`), { platform: "mailchimp", ...a, read: now }); flows++; }
  }
  if (s.platforms.includes("klaviyo")) {
    for (const f of await kl.flows(ctx)) { await ctx.store.put("flows", keyOf(`klaviyo:${f.id}`), { platform: "klaviyo", ...f, read: now }); flows++; }
  }
  ctx.log(`sync: ${sends} sends read, ${under} under target, ${flows} flows read`);
  return { sends, under_target: under, flows };
}

/** Daily: draft each newsletter the agent has written as a Mailchimp draft campaign, then queue its scheduled send. */
export async function draft(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const bad = settingsProblem(s, "mailchimp");
  if (bad) throw new Error(`draft: ${bad}`);
  if (s.newsletter !== "mailchimp") throw new Error("draft: newsletters are drafted in mailchimp only");
  let created = 0, queued = 0, parked = 0;
  const park = (key: string, n: Newsletter, reason: string, campaign_id?: string) =>
    ctx.store.put("newsletters", key, { ...n, status: "needs-attention", campaign_id, reason: line(reason, 200) });
  for (const [key, n] of Object.entries(await ctx.store.list<Newsletter>("newsletters"))) {
    if (n.status === "queued" || n.status === "needs-attention") continue;
    if (n.status === "creating") { await park(key, n, "a campaign may already exist in Mailchimp: check it, then reset the status to new", n.campaign_id); parked++; continue; }
    const problem = newsletterProblem(n, ctx.now);
    if (problem) { await park(key, n, problem, n.campaign_id); parked++; continue; }
    let campaign_id = n.campaign_id;
    try {
      if (!campaign_id) {
        await ctx.store.put("newsletters", key, { ...n, status: "creating" });   // written before the call, so a crash is seen, not repeated
        campaign_id = await mc.createCampaign(ctx, key, n);
        await ctx.store.put("newsletters", key, { ...n, status: "content", campaign_id });
        created++;
      }
      await mc.setContent(ctx, campaign_id, n.html);
      await mc.queueSchedule(ctx, key, campaign_id, n);
      await ctx.store.put("newsletters", key, { ...n, status: "queued", campaign_id, reason: undefined });
      queued++;
    } catch (e: any) {
      await park(key, n, `mailchimp: ${String(e?.message ?? e)}`, campaign_id);
      parked++;
    }
  }
  ctx.log(`draft: ${created} campaigns created, ${queued} schedules queued, ${parked} parked`);
  return { created, queued, parked };
}

/** Daily: queue each flow change the agent has proposed. A start, pause, live or manual change reaches subscribers, so it waits. */
export async function flows(ctx: Ctx<Settings>) {
  let queued = 0, parked = 0;
  for (const [key, c] of Object.entries(await ctx.store.list<FlowChange>("flow-changes"))) {
    if (c.status === "queued" || c.status === "needs-attention") continue;
    const bad = flowProblem(c) ?? settingsProblem(ctx.settings, c.platform);
    if (bad) { await ctx.store.put("flow-changes", key, { ...c, status: "needs-attention", error: line(bad, 200) }); parked++; continue; }
    try {
      if (c.platform === "mailchimp") await mc.queueFlowEmail(ctx, key, c);
      else await kl.queueFlowStatus(ctx, key, c);
      await ctx.store.put("flow-changes", key, { ...c, status: "queued", error: undefined });
      queued++;
    } catch (e: any) {
      await ctx.store.put("flow-changes", key, { ...c, status: "needs-attention", error: line(e?.message ?? e, 200) });
      parked++;
    }
  }
  ctx.log(`flows: ${queued} changes queued, ${parked} parked`);
  return { queued, parked };
}

export const CRONS = { sync, draft, flows };
