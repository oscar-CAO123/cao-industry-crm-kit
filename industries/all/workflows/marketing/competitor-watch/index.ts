// The competitor-watch workflow's four crons. Each reads, drafts and stores; none sends. The only live act, creating the
// Semrush tracking project for the client's domain, is queued once and waits for a person to approve it in the CRM shell.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import type { AuthorityRow, Post, Settings, Suggestion } from "./types.ts";
import { setupProblem, clean } from "./types.ts";
import { semrush } from "./adapters/semrush.ts";
import { meta } from "./adapters/meta-ads.ts";

interface SuggestionSnapshot { at: string; domain: string; items: Suggestion[] }
interface PostRecord { at: string; competitor: string; baseline: boolean; new_posts: Post[] }
interface AuthoritySnapshot { at: string; rows: AuthorityRow[] }

const guard = (s: Settings) => { const p = setupProblem(s); if (p) throw new Error(`competitor-watch: ${p}`); };

/** Weekly, Monday 19:00 UTC: similar domains from Semrush (suggestions only), and one queued approval to create the Semrush project. */
export async function discover(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  guard(s);
  const items = await semrush.competitors(ctx, s.domain);
  await ctx.store.put("suggestions", "latest", { at: ctx.now.toISOString(), domain: s.domain, items } satisfies SuggestionSnapshot);
  const done = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, semrush.projectKey(s.domain)));
  let queued = 0;
  if (!done || done.status !== "done") { await ctx.queue(semrush.createProjectAct(s)); queued = 1; }
  ctx.log(`discover: ${items.length} similar domains, ${queued} project approval queued`);
  return { suggestions: items.length, queued };
}

/** Daily, 20:00 UTC: the newest public posts on each competitor's Facebook Page. The first run only sets the baseline. */
export async function watch(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  guard(s);
  let pages = 0, fresh = 0, baselined = 0;
  for (const c of s.competitors.filter((x) => x.facebook_page_id)) {
    const id = c.facebook_page_id!;
    pages++;
    const posts = await meta.pagePosts(ctx, id);
    const before = await ctx.store.get<{ ids: string[] }>("seen", id);
    const known = new Set(before?.ids ?? []);
    const news = before ? posts.filter((p) => !known.has(p.id)) : [];
    if (!before) baselined++;
    fresh += news.length;
    await ctx.store.put("seen", id, { ids: [...new Set([...posts.map((p) => p.id), ...(before?.ids ?? [])])].slice(0, 200) });
    await ctx.store.put("posts", id, { at: ctx.now.toISOString(), competitor: clean(c.name, 80), baseline: !before, new_posts: news } satisfies PostRecord);
  }
  ctx.log(`watch: ${pages} pages, ${fresh} new posts, ${baselined} baselined`);
  return { pages, new_posts: fresh, baselined };
}

/** Weekly, Monday 20:30 UTC: Semrush authority for the client and each competitor domain, with last week kept for comparison. */
export async function authority(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  guard(s);
  const domains = [s.domain, ...s.competitors.map((c) => c.domain).filter((d): d is string => !!d)];
  const rows = await semrush.comparison(ctx, domains);
  const prev = await ctx.store.get<AuthoritySnapshot>("authority", "latest");
  if (prev) await ctx.store.put("authority", "previous", prev);
  await ctx.store.put("authority", "latest", { at: ctx.now.toISOString(), rows } satisfies AuthoritySnapshot);
  ctx.log(`authority: ${rows.length} of ${domains.length} domains`);
  return { domains: domains.length, rows: rows.length };
}

/** Daily, 21:00 UTC: write the report from what the other crons stored. Makes no platform calls. */
export async function report(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  guard(s);
  const posts: (PostRecord & { page_id: string })[] = [];
  const missing: string[] = [];
  for (const c of s.competitors) {
    if (!c.facebook_page_id) { missing.push(`${clean(c.name, 80)}: no Facebook Page id, posts not watched`); continue; }
    const rec = await ctx.store.get<PostRecord>("posts", c.facebook_page_id);
    if (rec) posts.push({ ...rec, page_id: c.facebook_page_id });
    else missing.push(`${clean(c.name, 80)}: posts not read yet`);
  }
  const auth = await ctx.store.get<AuthoritySnapshot>("authority", "latest");
  const prev = await ctx.store.get<AuthoritySnapshot>("authority", "previous");
  const authority = (auth?.rows ?? []).map((r) => {
    const before = prev?.rows.find((x) => x.domain === r.domain);
    return { ...r, score_change: before ? r.score - before.score : null, backlinks_change: before ? r.backlinks_count - before.backlinks_count : null };
  });
  const watched = new Set([s.domain, ...s.competitors.map((c) => c.domain).filter(Boolean)]);
  const sug = await ctx.store.get<SuggestionSnapshot>("suggestions", "latest");
  const suggestions = (sug?.items ?? []).filter((x) => !watched.has(x.domain)).slice(0, 5);
  await ctx.store.put("reports", "latest", {
    at: ctx.now.toISOString(), business: clean(s.business_name ?? s.domain, 120),
    new_posts: posts.flatMap((p) => p.new_posts.map((x) => ({ competitor: p.competitor, ...x }))),
    posts_baselined_only: posts.length > 0 && posts.every((p) => p.baseline),
    authority, authority_from: auth?.at ?? null, suggestions, suggestions_from: sug?.at ?? null,
    missing,
    not_covered: "Competitor ads and prices are not covered: the kit maps no ad library or price operation. LinkedIn competitor activity is not mapped.",
  });
  const fresh = posts.reduce((n, p) => n + p.new_posts.length, 0);
  ctx.log(`report: ${fresh} new posts, ${authority.length} authority rows, ${missing.length} gaps in watching`);
  return { new_posts: fresh, authority: authority.length, suggestions: suggestions.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { discover, watch, authority, report };
