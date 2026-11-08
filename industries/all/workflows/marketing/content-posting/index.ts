// The content-posting workflow's two crons. draft turns each planned post into an unpublished Instagram container (a draft)
// and queues its live publish for approval. track reads recent posts and keeps the list. Nothing here publishes.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { PlannedPost, Settings } from "./types.ts";
import { problem, setupProblem, keyOf } from "./types.ts";
import { meta } from "./adapters/meta-ads.ts";

/** Every 30 minutes: plan to draft. A post gets its Instagram container once, and its publish is queued once. */
export async function draft(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`content-posting: ${setup}`);
  const todo = Object.values(await ctx.store.list<PlannedPost>("posts"))
    .filter((p) => p.status === "planned" || p.status === "drafted")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, s.post_limit_per_run ?? 5);
  let drafted = 0, queued = 0, skipped = 0;
  for (const p of todo) {
    const targets = p.channels.filter((c) => s.channels.includes(c));
    const why = targets.length ? problem(p, targets) : "none of its channels is set up for this client";
    if (why) { await ctx.store.put("posts", p.id, { ...p, status: "skipped", reason: why }); skipped++; continue; }
    let cur: PlannedPost = { ...p };
    if (targets.includes("instagram") && !cur.instagram) {
      const creation_id = await meta.instagramContainer(ctx, cur);
      cur = { ...cur, status: "drafted", reason: undefined, instagram: { creation_id } };
      await ctx.store.put("posts", p.id, cur);
      drafted++;
    }
    if (!cur.queued?.length) {
      const acts = meta.liveActs(s, cur, targets).map((a, i) => (i === 0 ? { ...a, key: keyOf(`post:${p.id}`) } : a));
      const id = await ctx.queue(acts, `Publish ${p.id} to ${targets.join(" and ")}: ${cur.caption.trim().slice(0, 80)}`);
      cur = { ...cur, status: "queued", queued: [id] };
      await ctx.store.put("posts", p.id, cur);
      queued++;
    }
  }
  ctx.log(`draft: ${drafted} drafted, ${queued} queued for approval, ${skipped} skipped`);
  return { drafted, queued, skipped };
}

/** Daily: read what has gone up on each configured channel and keep the list for the owner's review. Reads only. */
export async function track(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const setup = setupProblem(s);
  if (setup) throw new Error(`content-posting: ${setup}`);
  const recent = await meta.recent(ctx, s.channels, s.history_limit ?? 25);
  await ctx.store.put("history", "latest", { at: ctx.now.toISOString(), ...recent });
  ctx.log(`track: ${recent.instagram.length} Instagram, ${recent.facebook.length} Facebook`);
  return { instagram: recent.instagram.length, facebook: recent.facebook.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { draft, track };
