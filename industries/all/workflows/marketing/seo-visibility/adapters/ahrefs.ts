// Ahrefs: the reads behind the four crons, and the one removal that waits for approval.
// Every operation id and parameter name comes from core/sdk/platforms/ahrefs/ops.json, which is generated from
// the vendor's OpenAPI spec (docs.ahrefs.com). Read responses are data: they are saved, never followed.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { CallInput } from "../../../../../../core/sdk/call.ts";
import { type Settings, daysAgo, day } from "../types.ts";

const P = "ahrefs";

/** Rank Tracker: where each tracked keyword ranks for the target project, on the chosen device. */
export async function rankOverview(ctx: Ctx<Settings>): Promise<unknown> {
  const a = ctx.settings.ahrefs;
  const r = await ctx.draft<any>({ platform: P, op: "rank-tracker.overview", summary: "Rank Tracker overview",
    input: { params: { select: "keyword,best_position_kind,clicks,country", project_id: a.project_id, device: a.device, date: day(ctx.now), limit: 200 } } });
  return r.data;
}

/** Search Console keywords the site appears for, last 28 days, through Ahrefs. */
export async function gscKeywords(ctx: Ctx<Settings>): Promise<unknown> {
  const r = await ctx.draft<any>({ platform: P, op: "gsc.keywords", summary: "Search Console keywords",
    input: { params: { project_id: ctx.settings.ahrefs.project_id, date_from: daysAgo(ctx.now, 28), date_to: day(ctx.now), limit: 100 } } });
  return r.data;
}

/** Keywords Explorer: volume, difficulty and traffic potential for the seed keywords. */
export async function keywordOverview(ctx: Ctx<Settings>): Promise<unknown> {
  const r = await ctx.draft<any>({ platform: P, op: "keywords-explorer.overview", summary: "Keywords Explorer overview for seed keywords",
    input: { params: { select: "keyword,volume,difficulty,traffic_potential,cpc", keywords: ctx.settings.seed_keywords.join(","), country: ctx.settings.ahrefs.country } } });
  return r.data;
}

/** The keywords already tracked in the Rank Tracker project. */
export async function trackedKeywords(ctx: Ctx<Settings>): Promise<string[]> {
  const r = await ctx.draft<any>({ platform: P, op: "management.project-keywords", summary: "tracked keywords",
    input: { params: { project_id: ctx.settings.ahrefs.project_id } } });
  return (r.data?.keywords ?? []).map((k: any) => String(k?.keyword ?? "")).filter(Boolean);
}

/** Broken backlinks: referring pages that link to 404 pages on the target domain. */
export async function brokenBacklinks(ctx: Ctx<Settings>): Promise<unknown> {
  const r = await ctx.draft<any>({ platform: P, op: "site-explorer.broken-backlinks", summary: "broken backlinks",
    input: { params: { select: "anchor,first_seen_link,http_code_target,domain_rating_source", target: ctx.settings.ahrefs.target, mode: "domain", limit: 100 } } });
  return r.data;
}

/** Brand Radar: share of voice for the brand across the chosen AI assistants. */
export async function shareOfVoice(ctx: Ctx<Settings>): Promise<unknown> {
  const b = ctx.settings.brand_radar!;
  const params: Record<string, unknown> = { report_id: b.report_id, data_source: b.models };
  if (b.brand) params.brand = b.brand;
  const r = await ctx.draft<any>({ platform: P, op: "brand-radar.sov-overview", summary: "Brand Radar share of voice", input: { params } });
  return r.data;
}

/** The one live write: remove keywords from the Rank Tracker project. Only ever queued, never run by a cron. */
export function removeKeywordsInput(projectId: number, keywords: string[]): CallInput {
  return { params: { project_id: projectId }, body: { keywords: keywords.map((keyword) => ({ keyword })) } };
}
