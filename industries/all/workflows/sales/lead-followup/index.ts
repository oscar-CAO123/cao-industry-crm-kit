// The lead follow-up workflow's three crons. Each reads, drafts and queues; it never sends and never changes a stage.
// Judgment (whether a lead is worth chasing, what to say to a particular person) belongs to the person in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Adapter, Lead, Platform, Settings } from "./types.ts";
import { DAY, leadKey, touchDue, render, clip, checkSettings } from "./types.ts";
import { pipedrive } from "./adapters/pipedrive.ts";
import { gohighlevel } from "./adapters/gohighlevel.ts";

export const ADAPTERS: Record<Platform, Adapter> = { pipedrive, gohighlevel };
const adapter = (s: Settings): Adapter => { checkSettings(s); return ADAPTERS[s.crm]; };
/** Touches queued in one draft run, so a long backlog spreads over several runs. */
const TOUCH_LIMIT = 50;

/** Every 15 minutes: pick up open leads and quotes in the watched stages; mark any that have left them. */
export async function intake(ctx: Ctx<Settings>) {
  const a = adapter(ctx.settings), now = ctx.now.toISOString();
  const present = new Set<string>();
  let added = 0, truncated = false;
  for (const w of ctx.settings.watch) {
    const { items, truncated: cut } = await a.watched(ctx, w);
    if (cut) truncated = true;
    for (const f of items) {
      if (f.status !== "open") continue;
      const key = leadKey(ctx.settings.crm, f.id);
      present.add(key);
      const prev = await ctx.store.get<Lead>("leads", key);
      if (!prev) {
        await ctx.store.put("leads", key, { key, platform: ctx.settings.crm, id: f.id, role: w.role, title: f.title, stage_id: f.stage_id,
          status: "active", first_seen: now, seen_at: now, touches: 0, contact_id: f.contact_id } satisfies Lead);
        added++;
      } else {
        // Back in a watched stage: follow-up resumes where it stopped. A lead already lost stays lost.
        const back = prev.status === "left-stage";
        await ctx.store.put("leads", key, { ...prev, title: f.title, stage_id: f.stage_id, seen_at: now, contact_id: f.contact_id ?? prev.contact_id,
          status: back ? "active" : prev.status, moved_at: back ? undefined : prev.moved_at });
      }
    }
  }
  // A lead that has left every watched stage stops getting touches. Skipped when a list was cut short, so a long list never ends a lead by mistake.
  let left = 0;
  if (!truncated) for (const lead of Object.values(await ctx.store.list<Lead>("leads"))) {
    if (lead.platform !== ctx.settings.crm || lead.status !== "active" || present.has(lead.key)) continue;
    await ctx.store.put("leads", lead.key, { ...lead, status: "left-stage", moved_at: now });
    left++;
  }
  ctx.log(`intake: ${added} new, ${left} left a watched stage${truncated ? " (a list was cut short; stage exits not checked)" : ""}`);
  return { added, left_stage: left, truncated };
}

/** Every 30 minutes: draft the first contact or the next follow-up that is due, and queue each send for approval. */
export async function draft(ctx: Ctx<Settings>) {
  const s = ctx.settings, a = adapter(s), now = ctx.now, nowIso = now.toISOString();
  const leads = Object.values(await ctx.store.list<Lead>("leads")).filter((l) => l.platform === s.crm && touchDue(l, s, now));
  let touched = 0, held = 0;
  for (const lead of leads) {
    if (touched >= TOUCH_LIMIT) break;
    const n = lead.touches;
    if (a.queueSend && !lead.contact_id) {
      await ctx.store.put("leads", lead.key, { ...lead, reason: "no contact on the opportunity: a person sends this one" });
      held++;
      continue;
    }
    const tpl = n === 0 && lead.role === "quote" && s.templates.quote_first ? s.templates.quote_first
      : n === 0 ? s.templates.first_touch : s.templates.follow_up[n - 1];
    if (!tpl) continue;
    const text = clip(render(tpl, { business_name: clip(s.business_name, 80), title: clip(lead.title, 80) }), 600);
    await a.draftTouch(ctx, lead, text, n);
    const approval = a.queueSend ? await a.queueSend(ctx, lead, text, `touch:${lead.key}:${n}`) : undefined;
    await ctx.store.put("leads", lead.key, { ...lead, touches: n + 1, last_touch: nowIso, last_approval: approval, reason: undefined });
    touched++;
  }
  ctx.log(`draft: ${touched} touches drafted, ${held} held`);
  return { touched, held };
}

/** Every day at 22:00 UTC (8 or 9 am in eastern Australia): queue a move to lost for leads that went quiet after the last follow-up. */
export async function chase(ctx: Ctx<Settings>) {
  const s = ctx.settings, a = adapter(s), now = ctx.now.getTime();
  if (!s.lost_after_days) return { lost_queued: 0, note: "lost_after_days is not set" };
  let queued = 0;
  for (const lead of Object.values(await ctx.store.list<Lead>("leads"))) {
    if (lead.platform !== s.crm || lead.status !== "active" || lead.lost_queued) continue;
    if (lead.touches <= s.follow_up.after_days.length) continue;                        // follow-ups still to go
    if (!lead.last_touch || now - Date.parse(lead.last_touch) < s.lost_after_days * DAY) continue;
    const id = await a.queueLost(ctx, lead, `lost:${lead.key}`);
    await ctx.store.put("leads", lead.key, { ...lead, lost_queued: id });
    queued++;
  }
  ctx.log(`chase: ${queued} moves to lost queued for approval`);
  return { lost_queued: queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, chase };
