// The speed-to-lead workflow's three crons. Each reads, drafts internal tasks, or queues a text for approval. None sends.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Lead, type Settings, MIN, HOUR, checkSettings, firstTouch } from "./types.ts";
import { gohighlevel as ghl } from "./adapters/gohighlevel.ts";

const P = "gohighlevel";
const windowMs = (s: Settings) => (s.alert_window_hours ?? 24) * HOUR;
const age = (ctx: Ctx<Settings>, lead: Lead) => ctx.now.getTime() - Date.parse(lead.created);
const openLeads = async (ctx: Ctx<Settings>) => Object.values(await ctx.store.list<Lead>("leads")).filter((l) => !l.closed);
async function close(ctx: Ctx<Settings>, lead: Lead, why: string) {
  await ctx.store.put("leads", lead.key, { ...lead, closed: why });
}

/** Still in the new-lead stage with no outbound message yet: the only state where the workflow keeps working. */
async function stateOf(ctx: Ctx<Settings>, lead: Lead): Promise<"waiting" | "handled" | "touched"> {
  const o = await ghl.opportunity(ctx, lead.opp);
  if (o.status !== "open" || o.pipelineStageId !== ctx.settings.new_lead_stage_id) return "handled";
  if (await ghl.hasOutbound(ctx, lead.contact)) return "touched";
  return "waiting";
}

/** Every 5 minutes: record new leads, and draft one instant alert task to the owner for each. */
export async function intake(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  let added = 0, alerted = 0;
  for (const r of await ghl.newOpenLeads(ctx)) {
    const key = `${P}:${r.opp}`;
    if (await ctx.store.get<Lead>("leads", key)) continue;
    const old = ctx.now.getTime() - Date.parse(r.created) > windowMs(ctx.settings);
    await ctx.store.put("leads", key, { key, opp: r.opp, contact: r.contact, name: r.name, phone: r.phone, created: r.created,
      ...(old ? { closed: "older than the alert window when first seen" } : {}) } satisfies Lead);
    added++;
  }
  for (const lead of await openLeads(ctx)) {
    if (lead.alerted) continue;
    await ghl.task(ctx, lead.contact, ctx.settings.owner_user_id, `New lead ${lead.name}: reach out now`,
      `Came in at ${lead.created}. Nobody has contacted them yet.`);
    await ctx.store.put("leads", lead.key, { ...lead, alerted: ctx.now.toISOString() });
    alerted++;
  }
  ctx.log(`intake: ${added} new, ${alerted} alerted`);
  return { added, alerted };
}

/** Every 10 minutes: once a lead has waited the set time with no reply, queue one first text for approval. */
export async function chase(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  let queued = 0;
  for (const lead of await openLeads(ctx)) {
    if (lead.chased) continue;
    if (age(ctx, lead) < ctx.settings.first_touch.after_minutes * MIN) continue;
    if (age(ctx, lead) > windowMs(ctx.settings)) { await close(ctx, lead, "stale"); continue; }
    if (!lead.phone) continue;   // nothing to text; the escalation still runs
    const state = await stateOf(ctx, lead);
    if (state !== "waiting") { await close(ctx, lead, state === "touched" ? "contacted" : "moved on"); continue; }
    const message = firstTouch(ctx.settings, lead);
    await ctx.queue({ platform: P, op: "conversations.send-a-new-message", key: `chase:${lead.key}`, summary: `First text to ${lead.name}`,
      input: { body: { type: "SMS", subType: "SMS", contactId: lead.contact, message, status: "pending" } } },
      `First text to ${lead.name} (${lead.phone}): "${message}"`);
    await ctx.store.put("leads", lead.key, { ...lead, chased: ctx.now.toISOString() });
    queued++;
  }
  ctx.log(`chase: ${queued} queued for approval`);
  return { queued };
}

/** Every 15 minutes: a lead still waiting past the escalation time gets one task for the senior person. */
export async function escalate(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  let drafted = 0;
  for (const lead of await openLeads(ctx)) {
    if (lead.escalated) continue;
    if (age(ctx, lead) < ctx.settings.escalate_after_minutes * MIN) continue;
    if (age(ctx, lead) > windowMs(ctx.settings)) { await close(ctx, lead, "stale"); continue; }
    const state = await stateOf(ctx, lead);
    if (state !== "waiting") { await close(ctx, lead, state === "touched" ? "contacted" : "moved on"); continue; }
    await ghl.task(ctx, lead.contact, ctx.settings.senior_user_id, `Not contacted in ${ctx.settings.escalate_after_minutes} minutes: ${lead.name}`,
      `Created ${lead.created}. Check the lead and call them.`);
    await ctx.store.put("leads", lead.key, { ...lead, escalated: ctx.now.toISOString() });
    drafted++;
  }
  ctx.log(`escalate: ${drafted} tasks drafted`);
  return { drafted };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, chase, escalate };
