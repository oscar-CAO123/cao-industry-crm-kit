// Semrush: the one adapter this job maps with competitor operations. Reads are drafts. Creating the tracking project is live,
// so it is only ever passed to ctx.queue. Field names come from Semrush's Backlinks API v4 page in the endpoint map:
// competitors returns { data: [{ domain, similarity, common_refdomains }] }, comparison returns
// { data: [{ url, score, backlinks_count, domains_count, follows_count }] }, and projects takes a body of { domain, project_name }.
// Semrush's Backlinks API v4 is in Early Access per its own docs, so the response shape can change.
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import type { AuthorityRow, Settings, Suggestion } from "../types.ts";
import { DOMAIN, num, keyOf, projectName } from "../types.ts";

const P = "semrush";
const ok = (r: { status: number }, what: string) => { if (r.status >= 300) throw new Error(`semrush: ${what} failed with status ${r.status}`); };
const rows = (r: { data?: any }) => (Array.isArray(r.data?.data) ? r.data.data : []) as any[];

export const semrush = {
  /** Draft: the domains Semrush finds most like the client's. Suggestions only; nothing is added to the watchlist. */
  async competitors(ctx: Ctx<Settings>, domain: string): Promise<Suggestion[]> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_apis_v4_backlinks_v1_competitors", summary: `similar domains to ${domain}`,
      input: { params: { domain, order_by: "similarity", direction: "DESC", limit: 10 } } });
    ok(r, "competitors");
    return rows(r)
      .filter((x) => DOMAIN.test(String(x?.domain ?? "")) && String(x.domain).toLowerCase() !== domain.toLowerCase())
      .map((x) => ({ domain: String(x.domain).toLowerCase(), similarity: num(x.similarity), common_refdomains: num(x.common_refdomains) }));
  },

  /** Draft: authority numbers for up to ten domains at root-domain scope. Costs 40 Semrush API units per line, so run it weekly. */
  async comparison(ctx: Ctx<Settings>, domains: string[]): Promise<AuthorityRow[]> {
    const list = domains.map((d) => String(d).toLowerCase());
    if (list.length < 1 || list.length > 10 || list.some((d) => !DOMAIN.test(d))) throw new Error("semrush: comparison needs one to ten bare domains");
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_apis_v4_backlinks_v1_comparison", summary: `authority for ${list.length} domains`,
      input: { params: { urls: list.join(","), scope: "ROOT_DOMAIN", fields: "url,score,backlinks_count,domains_count,follows_count" } } });
    ok(r, "comparison");
    const out: AuthorityRow[] = [];
    for (const x of rows(r)) {
      const d = String(x?.url ?? "").toLowerCase();
      if (!list.includes(d)) continue;   // only the domains asked for are kept
      out.push({ domain: d, score: num(x.score), backlinks_count: num(x.backlinks_count), domains_count: num(x.domains_count), follows_count: num(x.follows_count) });
    }
    return out;
  },

  /** The store key that marks the Semrush project for one client domain as approved. */
  projectKey: (domain: string) => keyOf(`semrush-project:${domain.toLowerCase()}`),

  /** The live act that creates the Semrush tracking project for the client's domain. Only ever passed to ctx.queue. */
  createProjectAct(s: Settings): Act {
    return { platform: P, op: "docs.post_apis_v4_projects_v1_projects", key: semrush.projectKey(s.domain),
      summary: `create the Semrush project "${projectName(s)}" for ${s.domain}`,
      input: { body: { domain: s.domain, project_name: projectName(s) } } };
  },
};
