// The reviews workflow's two crons. reviews reads the business's reviews and drafts a reply for each one that needs an
// answer; it never posts a reply. ask queues one review request per completed job, and a person approves each one.
// No cron sends, posts or tags anything on its own.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type CompletedJob, type ReplyDraft, type ReviewAdapter, type Settings, JOB_ID, UUID, clean, settingsProblem } from "./types.ts";
import { podium } from "./adapters/podium.ts";
import { gohighlevel } from "./adapters/gohighlevel.ts";

const DEFAULT_POSITIVE = "Thanks for the review. We appreciate you taking the time to write it.";
const DEFAULT_NEGATIVE = "Thanks for telling us. We want to put this right, so someone from our team will be in touch.";

function adapterFor(s: Settings): ReviewAdapter {
  const bad = settingsProblem(s);
  if (bad) throw new Error(`reviews: ${bad}`);
  return s.review_platform === "podium" ? podium : gohighlevel;
}

/** Every 30 minutes: read the reviews and draft a reply for each one that needs an answer. Drafts only; nothing is posted. */
export async function reviews(ctx: Ctx<Settings>) {
  const a = adapterFor(ctx.settings);
  const list = (await a.reviews(ctx)).filter((r) => UUID.test(r.uid));
  const low = ctx.settings.low_rating_max ?? 3;
  let drafted = 0, flagged = 0;
  for (const r of list) {
    await ctx.store.put("reviews", r.uid, r);
    if (!r.needsResponse || (await ctx.store.get("reply_drafts", r.uid))) continue;
    const flag = r.rating === undefined || r.rating <= low;
    const text = flag ? (ctx.settings.reply_templates?.negative ?? DEFAULT_NEGATIVE) : (ctx.settings.reply_templates?.positive ?? DEFAULT_POSITIVE);
    const d: ReplyDraft = { uid: r.uid, rating: r.rating, flagged: flag, draft: clean(text, 1000), created: ctx.now.toISOString() };
    await ctx.store.put("reply_drafts", r.uid, d);
    drafted++;
    if (flag) flagged++;
  }
  ctx.log(`reviews: ${list.length} read, ${drafted} reply drafts (${flagged} flagged for a person)`);
  return { read: list.length, drafted, flagged };
}

/** Every 30 minutes: queue a review request for each completed job not yet asked. A person approves each one. */
export async function ask(ctx: Ctx<Settings>) {
  const a = adapterFor(ctx.settings);
  const jobs = Object.values(await ctx.store.list<CompletedJob>("completed_jobs"))
    .filter((j) => JOB_ID.test(String(j.id ?? "")) && !j.ask_id)
    .sort((x, y) => String(x.completed_at ?? "").localeCompare(String(y.completed_at ?? "")))
    .slice(0, ctx.settings.ask_limit_per_run ?? 20);
  let queued = 0, skipped = 0;
  for (const j of jobs) {
    try {
      const id = await a.ask(ctx, j);
      if (id) {
        await ctx.store.put("completed_jobs", j.id, { ...j, ask_id: id, problem: undefined });
        queued++;
      } else {
        await ctx.store.put("completed_jobs", j.id, { ...j, problem: "no usable phone or email, and no GoHighLevel contact on the job" });
        skipped++;
      }
    } catch (e) {
      await ctx.store.put("completed_jobs", j.id, { ...j, problem: clean((e as Error).message, 200) });
      skipped++;
    }
  }
  ctx.log(`ask: ${queued} queued, ${skipped} skipped`);
  return { queued, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { reviews, ask };
