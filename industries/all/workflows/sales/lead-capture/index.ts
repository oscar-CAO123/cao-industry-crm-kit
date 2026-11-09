// The lead capture workflow's three crons. Each reads, records and queues. None sends: a message to a lead is queued
// as an approval, and a person presses approve in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import type { Lead, Settings } from "./types.ts";
import * as gh from "./adapters/gohighlevel.ts";

const HOUR = 36e5;

/** Every 10 minutes: new form submissions and unread live chats become leads: tagged, with an opportunity in the new-lead stage. */
export async function intake(ctx: Ctx<Settings>) {
  const base = await ctx.store.get<{ at: string }>("state", "baseline");
  if (!base) {
    // First run: record the start time and import nothing, so old form submissions do not become new leads.
    await ctx.store.put("state", "baseline", { at: ctx.now.toISOString() });
    ctx.log("intake: baseline set; leads from before this run are not imported");
    return { added: 0, baseline: true };
  }
  const found = [...(await gh.readSubmissions(ctx, Date.parse(base.at))), ...(await gh.readChats(ctx, Date.parse(base.at)))];
  let added = 0;
  for (const raw of found) {
    const key = safeKey(`${gh.P}:${raw.source}:${raw.ref}`);
    if (await ctx.store.get<Lead>("leads", key)) continue;
    const lead: Lead = { ...raw, key, status: "captured", followups: [] };
    try {
      // Recorded before any write to the platform, so a re-run never opens a second opportunity for the same lead.
      await ctx.store.put("leads", key, lead);
      await gh.tagContact(ctx, raw.contactId, ctx.settings.lead_tags ?? []);
      const opportunity = await gh.openOpportunity(ctx, lead);
      if (opportunity) await ctx.store.put("leads", key, { ...lead, opportunity });
      added++;
    } catch (e: any) {
      ctx.log(`intake: lead ${key} not finished: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: queue a short acknowledgement for each new lead that has an email (or a phone, for SMS). */
export async function acknowledge(ctx: Ctx<Settings>) {
  const ack = ctx.settings.acknowledgement;
  if (!ack) return { queued: 0, skipped: 0 };
  let queued = 0, skipped = 0;
  for (const lead of Object.values(await ctx.store.list<Lead>("leads"))) {
    if (lead.status !== "captured") continue;
    const act = gh.messageAct(ctx.settings, lead, ack.channel, ack.text, ack.subject ?? "Thanks for getting in touch", `ack:${lead.key}`, "acknowledgement");
    if (!act) { skipped++; continue; }
    await ctx.queue(act, `Acknowledge ${lead.name || "a lead"}: ${act.summary}`);
    await ctx.store.put("leads", lead.key, { ...lead, status: "queued" });
    queued++;
  }
  ctx.log(`acknowledge: ${queued} queued, ${skipped} without a usable contact`);
  return { queued, skipped };
}

/** Daily: queue a follow-up for each lead who has not replied or booked, once the wait has passed, up to the set number. */
export async function followUp(ctx: Ctx<Settings>) {
  const fu = ctx.settings.follow_up;
  if (!fu) return { queued: 0 };
  const channel = ctx.settings.acknowledgement?.channel ?? "Email";
  let queued = 0;
  for (const lead of Object.values(await ctx.store.list<Lead>("leads"))) {
    if (lead.status !== "queued") continue;
    if (lead.followups.length >= fu.max) continue;
    const last = Date.parse(lead.followups.at(-1) ?? lead.received);
    if (ctx.now.getTime() - last < fu.after_hours * HOUR) continue;
    if (await gh.engaged(ctx, lead.contactId)) {
      await ctx.store.put("leads", lead.key, { ...lead, status: "replied" });
      continue;
    }
    const n = lead.followups.length + 1;
    const act = gh.messageAct(ctx.settings, lead, channel, fu.text, "Following up", `follow${n}:${lead.key}`, `follow-up ${n}`);
    if (!act) continue;
    await ctx.queue(act, `Follow-up ${n} for ${lead.name || "a lead"}: ${act.summary}`);
    await ctx.store.put("leads", lead.key, { ...lead, followups: [...lead.followups, ctx.now.toISOString()] });
    queued++;
  }
  ctx.log(`follow-up: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, acknowledge, "follow-up": followUp };
