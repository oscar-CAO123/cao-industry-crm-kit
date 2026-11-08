// The referral-partners workflow's three crons. Each reads, drafts or queues. None sends.
// A referred lead comes in from Pipedrive. The referring partner is kept in ActiveCampaign, where a tag is what the
// business's own automation turns into an email, so every contact write and every tag waits for a person to approve it.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { DAY, EMAIL, FIELD_KEY, TAG, UUID, ackKey, partnerEmail, stageKey, type Referral, type Settings } from "./types.ts";
import * as pd from "./adapters/pipedrive.ts";
import * as ac from "./adapters/activecampaign.ts";

/** Checked before any read, so a half-filled client record fails at once. */
function settingsOk(s: Settings) {
  if (!UUID.test(s.pipedrive?.referral_label_id ?? "")) throw new Error("referral-partners: pipedrive.referral_label_id must be the referral lead label's UUID");
  if (!FIELD_KEY.test(s.pipedrive?.partner_email_field ?? "")) throw new Error("referral-partners: pipedrive.partner_email_field must be the 40-character custom field key");
  if (!TAG.test(s.activecampaign?.acknowledged_tag ?? "")) throw new Error("referral-partners: activecampaign.acknowledged_tag is not a valid tag name");
  for (const [stage, tag] of Object.entries(s.activecampaign?.stage_tags ?? {})) {
    if (!/^\d{1,12}$/.test(stage) || !TAG.test(tag)) throw new Error(`referral-partners: stage_tags entry ${stage} is not a stage id and tag name`);
  }
}

/** Every 15 minutes: referred leads from Pipedrive, each recorded once. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  settingsOk(ctx.settings);
  let added = 0, waiting = 0;
  for (const l of await pd.referralLeads(ctx)) {
    const key = `lead:${l.id}`;
    if (await ctx.store.get("referrals", key)) continue;
    const email = partnerEmail(ctx.settings, l);
    const r: Referral = { key, lead_id: String(l.id), title: String(l.title ?? "Referral").slice(0, 200), partner_email: email ?? "",
      status: email ? "new" : "needs-partner-email", received: ctx.now.toISOString() };
    await ctx.store.put("referrals", key, r);
    added++;
    if (!email) waiting++;
  }
  ctx.log(`intake: ${added} new referral(s), ${waiting} without a partner email`);
  return { added, needs_partner_email: waiting };
}

/** Every 30 minutes: queue one receipt per new referral. A person approves each one before the partner hears anything. */
export async function acknowledge(ctx: Ctx<Settings>) {
  settingsOk(ctx.settings);
  const tag = ctx.settings.activecampaign.acknowledged_tag;
  let queued = 0, acknowledged = 0, declined = 0;
  for (const r of Object.values(await ctx.store.list<Referral>("referrals"))) {
    if (r.status === "acknowledge-queued") {
      const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, ackKey(r)));
      if (ap?.status === "done") { r.status = "acknowledged"; acknowledged++; }
      else if (ap?.status === "rejected") { r.status = "declined"; declined++; }
      else continue;
      await ctx.store.put("referrals", r.key, r);
      continue;
    }
    if (r.status === "needs-partner-email") {
      const l = await pd.lead(ctx, r.lead_id);
      const email = l ? partnerEmail(ctx.settings, l) : undefined;
      if (!email) continue;
      r.status = "new";
      r.partner_email = email;
    }
    if (r.status !== "new" || !EMAIL.test(r.partner_email)) continue;
    await ctx.queue(ac.syncAct(r.partner_email, tag, ackKey(r)), `Acknowledge referral "${r.title}" to ${r.partner_email} (tag ${tag})`);
    r.status = "acknowledge-queued";
    await ctx.store.put("referrals", r.key, r);
    queued++;
  }
  ctx.log(`acknowledge: ${queued} queued, ${acknowledged} acknowledged, ${declined} declined`);
  return { queued, acknowledged, declined };
}

/** Hourly: when a referred deal reaches a stage with a tag, queue that tag for its partner. Reads Pipedrive and ActiveCampaign. */
export async function progress(ctx: Ctx<Settings>) {
  settingsOk(ctx.settings);
  const state = (await ctx.store.get<{ since?: string }>("state", "progress")) ?? {};
  const since = state.since ?? new Date(ctx.now.getTime() - 7 * DAY).toISOString();
  const byLead = new Map(Object.values(await ctx.store.list<Referral>("referrals"))
    .filter((r) => r.status === "acknowledged").map((r) => [r.lead_id, r] as const));
  let queued = 0;
  for (const d of await pd.dealsSince(ctx, since)) {
    const r = byLead.get(d.source_lead_id);
    const tag = ctx.settings.activecampaign.stage_tags[String(d.stage_id)];
    if (!r || !tag || r.tagged_stage === d.stage_id) continue;
    const summary = `Tell ${r.partner_email} that referral "${r.title}" reached a new stage (tag ${tag})`;
    const cid = await ac.contactId(ctx, r.partner_email);
    const key = stageKey(d.id, d.stage_id);
    await ctx.queue(cid ? ac.tagAct(cid, tag, key) : ac.syncAct(r.partner_email, tag, key), summary);
    r.deal_id = d.id;
    r.tagged_stage = d.stage_id;
    await ctx.store.put("referrals", r.key, r);
    queued++;
  }
  await ctx.store.put("state", "progress", { since: ctx.now.toISOString() });
  ctx.log(`progress: ${queued} stage update(s) queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, acknowledge, progress };
