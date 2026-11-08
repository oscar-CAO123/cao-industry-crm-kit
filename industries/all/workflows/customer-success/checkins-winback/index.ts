// The check-in, renewal and win-back workflow's three crons. Each reads or drafts; none sends.
// A send is only ever queued here, and a person approves it in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type CampaignRecord, type DueRecord, type ReplyRecord, type Settings, DAY, checkSettings, day, keyOf } from "./types.ts";
import { mailchimp, sendAct, subscriberHash } from "./adapters/mailchimp.ts";

/** Every 6 hours: read the list once and record which members in each group are due. Writes only to the store. */
export async function dueList(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const members = await mailchimp.members(ctx);
  const now = ctx.now.getTime();
  const counts: Record<string, number> = {};
  for (const g of ctx.settings.groups) {
    const hashes = members
      .filter((m) => m.tags.includes(g.tag) && now - Date.parse(m.last_changed) >= g.after_days * DAY)
      .map((m) => m.id);
    await ctx.store.put("due", g.name, { group: g.name, hashes, seen: ctx.now.toISOString() } satisfies DueRecord);
    counts[g.name] = hashes.length;
  }
  ctx.log(`due-list: ${JSON.stringify(counts)} due of ${members.length} subscribed`);
  return { subscribed: members.length, due: counts };
}

/** Hourly: one campaign draft per group per day, with the owner's text, and a send queued for approval. Never sends. */
export async function draft(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const today = day(ctx.now);
  let drafted = 0, skipped = 0;
  for (const g of ctx.settings.groups) {
    const due = await ctx.store.get<DueRecord>("due", g.name);
    if (!due || !due.hashes.length) { skipped++; continue; }
    if (ctx.now.getTime() - Date.parse(due.seen) > 13 * 36e5) { ctx.log(`draft: ${g.name} due list is stale, skipped`); skipped++; continue; }
    const key = keyOf(`${g.name}-${today}`);
    // One draft and one queued send per group per day: a re-run finds the record and does nothing.
    if (await ctx.store.get<CampaignRecord>("campaigns", key)) { skipped++; continue; }
    const campaignId = await mailchimp.createDraft(ctx, g);
    // Recorded at once, so a later failure never creates a second draft for the same day.
    await ctx.store.put("campaigns", key, { key, group: g.name, day: today, campaign_id: campaignId, due: due.hashes.length, created: ctx.now.toISOString() } satisfies CampaignRecord);
    await mailchimp.setContent(ctx, campaignId, g.html);
    await ctx.queue(sendAct(campaignId,
      `Send "${g.subject}" to the ${g.name} segment (${due.hashes.length} due at the last check). Campaign ${campaignId} is a draft in Mailchimp until approved.`,
      `send-${key}`));
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted and queued, ${skipped} skipped`);
  return { drafted, skipped };
}

/** Every 30 minutes: note each unread reply to a check-in campaign once, so a person knows to answer. The reply text is not read or acted on. */
export async function replies(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const convs = await mailchimp.unreadReplies(ctx);
  let noted = 0, skipped = 0;
  for (const c of convs.slice(0, 25)) {
    if (!c.from_email) { skipped++; continue; }
    const key = keyOf(`${c.id}-${c.message_count}`);
    if (await ctx.store.get<ReplyRecord>("replies", key)) { skipped++; continue; }
    const hash = subscriberHash(c.from_email);
    try {
      await mailchimp.note(ctx, hash, `Replied to a check-in campaign on ${day(ctx.now)}. A person needs to answer.`);
    } catch (e: any) {
      // One bad conversation (for example a member the list no longer holds) must not stop the rest.
      ctx.log(`replies: note failed for conversation ${c.id}: ${String(e?.status ?? e?.message ?? e).slice(0, 80)}`);
      skipped++;
      continue;
    }
    await ctx.store.put("replies", key, { key, hash, noted: ctx.now.toISOString() } satisfies ReplyRecord);
    noted++;
  }
  ctx.log(`replies: ${noted} noted, ${skipped} skipped`);
  return { noted, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "due-list": dueList, draft, replies };
