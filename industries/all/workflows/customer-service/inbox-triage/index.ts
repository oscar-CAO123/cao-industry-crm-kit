// The inbox-triage workflow's three crons. Each is deterministic: it reads, drafts and queues; it never sends.
// Judgment (a reply that no template covers, a complaint, a triage call) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Adapter, Enquiry, Platform, Settings } from "./types.ts";
import { classify, replyFor } from "./types.ts";
import { front } from "./adapters/front.ts";
import { googleWorkspace } from "./adapters/google-workspace.ts";

export const ADAPTERS: Record<Platform, Adapter> = { front, "google-workspace": googleWorkspace };
const HOUR = 3600e3;

/** Every 10 minutes: new mail from each source, sorted by keyword rules. Noise is skipped and never answered. */
export async function intake(ctx: Ctx<Settings>) {
  const since = ctx.now.getTime() - (ctx.settings.lookback_hours ?? 24) * HOUR;
  let added = 0;
  for (const p of ctx.settings.sources) {
    for (const e of await ADAPTERS[p].inbox(ctx)) {
      if (Date.parse(e.received) < since) continue;                         // old backlog is not triaged or answered automatically
      if (await ctx.store.get("enquiries", e.id)) continue;
      const category = classify(ctx.settings, e.subject, e.preview);
      await ctx.store.put("enquiries", e.id, { ...e, category, status: category === "noise" ? "skipped" : "triaged" } satisfies Enquiry);
      added++;
    }
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: where an approved template covers the mail, queue the reply for approval. Nothing is sent here. */
export async function draft(ctx: Ctx<Settings>) {
  const open = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => e.status === "triaged" && !e.replied && !e.reply_error);
  // Only mail a template covers takes a slot in the run, so mail with no template never holds the others back.
  const ready = open.flatMap((e) => { const text = replyFor(ctx.settings, e); return text ? [{ e, text }] : []; });
  const needs_reply = open.length - ready.length;
  let queued = 0, parked = 0;
  for (const { e, text } of ready.slice(0, ctx.settings.per_run_limit ?? 20)) {
    try {
      const approval = await ADAPTERS[e.source].queueReply!(ctx, e, text);
      await ctx.store.put("enquiries", e.id, { ...e, replied: approval } satisfies Enquiry);
      queued++;
    } catch (err) {
      // One thread that cannot take a reply (for example, no valid sender address) is parked for a person; the run carries on.
      await ctx.store.put("enquiries", e.id, { ...e, reply_error: String((err as Error)?.message ?? err).slice(0, 200) } satisfies Enquiry);
      parked++;
    }
  }
  ctx.log(`draft: ${queued} replies queued, ${needs_reply} need a person, ${parked} parked`);
  return { queued, needs_reply };
}

/** Every 30 minutes: assign each triaged thread to the teammate (Front) or label it (Gmail), once, with a turnaround reminder. */
export async function assign(ctx: Ctx<Settings>) {
  let done = 0;
  for (const e of Object.values(await ctx.store.list<Enquiry>("enquiries"))) {
    if (e.status !== "triaged" || e.assigned) continue;
    await ADAPTERS[e.source].assign(ctx, e);
    await ctx.store.put("enquiries", e.id, { ...e, assigned: ctx.now.toISOString() } satisfies Enquiry);
    done++;
  }
  ctx.log(`assign: ${done} assigned`);
  return { assigned: done };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, assign };
