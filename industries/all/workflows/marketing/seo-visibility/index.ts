// The seo-visibility workflow's four crons. Each reads Ahrefs and saves a dated report. Only one step can change
// anything, removing retired keywords from the Rank Tracker project, and a cron can only queue that for approval.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { type Report, type Settings, checkBrandRadar, checkSettings, day, lower } from "./types.ts";
import * as ahrefs from "./adapters/ahrefs.ts";

async function save(ctx: Ctx<Settings>, kind: Report["kind"], data: unknown) {
  const rep: Report = { kind, day: day(ctx.now), created: ctx.now.toISOString(), data };
  await ctx.store.put("reports", `${kind}:${rep.day}`, rep);
  ctx.log(`${kind}: saved report for ${rep.day}`);
  return rep.day;
}

/** Daily: positions and Search Console keywords for the target project. */
export async function rankings(ctx: Ctx<Settings>) {
  const why = checkSettings(ctx.settings);
  if (why) return { skipped: why };
  const data = { overview: await ahrefs.rankOverview(ctx), search_console: await ahrefs.gscKeywords(ctx) };
  return { saved: await save(ctx, "rankings", data) };
}

/** Weekly: volumes for the seed keywords, and queue removal of any retired keyword that is still tracked. */
export async function keywords(ctx: Ctx<Settings>) {
  const why = checkSettings(ctx.settings);
  if (why) return { skipped: why };
  const tracked = await ahrefs.trackedKeywords(ctx);
  const data = { seed_volumes: await ahrefs.keywordOverview(ctx), tracked_count: tracked.length };
  await save(ctx, "keywords", data);
  const present = new Set(tracked.map(lower));
  const retire = (ctx.settings.retire_keywords ?? []).filter((k) => present.has(lower(k)));
  if (!retire.length) return { queued: null, retire: 0 };
  const project = ctx.settings.ahrefs.project_id;
  const text = `Remove ${retire.length} retired keyword${retire.length === 1 ? "" : "s"} from Rank Tracker project ${project}: ${retire.join(", ")}`;
  const id = await ctx.queue({ platform: "ahrefs", op: "management.project-keywords-delete", input: ahrefs.removeKeywordsInput(project, retire),
    summary: text, key: safeKey(`retire:${project}:${retire.map(lower).sort().join("|")}`) }, text);
  return { queued: id, retire: retire.length };
}

/** Weekly: broken backlinks to restore or redirect. */
export async function backlinks(ctx: Ctx<Settings>) {
  const why = checkSettings(ctx.settings);
  if (why) return { skipped: why };
  return { saved: await save(ctx, "backlinks", await ahrefs.brokenBacklinks(ctx)) };
}

/** Weekly: share of voice across the AI assistants Brand Radar tracks. */
export async function aiVisibility(ctx: Ctx<Settings>) {
  const why = checkSettings(ctx.settings) ?? checkBrandRadar(ctx.settings);
  if (why) return { skipped: why };
  return { saved: await save(ctx, "ai-visibility", await ahrefs.shareOfVoice(ctx)) };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { rankings, keywords, backlinks, "ai-visibility": aiVisibility };
