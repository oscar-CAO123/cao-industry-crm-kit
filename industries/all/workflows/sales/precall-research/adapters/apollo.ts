// Apollo: outside research on the contact, the company, its news and its hiring. Field names come from Apollo's official REST
// spec in endpoint-map/raw/apollo/spec: people/match, organizations/enrich, news_articles/search and job_postings.
// Read only. No personal email or phone is revealed (reveal flags are never sent), and nothing is added to a sequence, list or task.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Article, type Job, type Company, APOLLO_ID, clip, iso, safeUrl } from "../types.ts";

const P = "apollo" as const;
const PERSON = "people-enrichment";
const ORG = "organization-enrichment";
const NEWS = "news_articles_search";
const JOBS = "organization-jobs-postings";

export const apollo = {
  /** Title and headline of a contact, matched by email or by company domain. */
  async person(ctx: Ctx<Settings>, email?: string, domain?: string): Promise<{ title?: string; headline?: string } | undefined> {
    if (!email && !domain) return undefined;
    const params: Record<string, unknown> = {};
    if (email) params.email = email;
    if (domain) params.domain = domain;
    const r = await ctx.draft<any>({ platform: P, op: PERSON, summary: "enrich the contact (no personal email or phone reveal)", input: { params } });
    const p = r.data?.person;
    if (!p) return undefined;
    return { title: clip(p.title, 120) || undefined, headline: clip(p.headline, 200) || undefined };
  },

  /** The company profile by domain, with Apollo's organization id for the news and hiring reads. */
  async org(ctx: Ctx<Settings>, domain: string): Promise<{ id?: string; company: Partial<Company> }> {
    const r = await ctx.draft<any>({ platform: P, op: ORG, summary: `enrich company ${domain}`, input: { params: { domain } } });
    const o = r.data?.organization;
    if (!o) return { company: {} };
    const place = [o.city, o.country].map((x) => clip(x, 60)).filter(Boolean).join(", ");
    return {
      id: APOLLO_ID.test(String(o.id ?? "")) ? String(o.id) : undefined,
      company: {
        name: clip(o.name, 200) || undefined,
        industry: clip(o.industry, 120) || undefined,
        employees: o.estimated_num_employees != null ? clip(o.estimated_num_employees, 20) : undefined,
        description: clip(o.short_description, 400) || undefined,
        location: place || undefined,
      },
    };
  },

  /** Recent news about the company, five at most. Links must be https. */
  async news(ctx: Ctx<Settings>, orgId: string): Promise<Article[]> {
    if (!APOLLO_ID.test(orgId)) throw new Error("precall-research: Apollo organization id must be 24 hex characters");
    const r = await ctx.draft<any>({ platform: P, op: NEWS, summary: "read news about the company",
      input: { params: { "organization_ids[]": orgId, per_page: 5 } } });
    return (Array.isArray(r.data?.news_articles) ? r.data.news_articles : []).slice(0, 5)
      .map((a: any): Article => ({ title: clip(a?.title, 200), url: safeUrl(a?.url), published_at: iso(a?.published_at) }))
      .filter((a: Article) => a.title && a.url);
  },

  /** Open job postings at the company, ten at most. */
  async jobs(ctx: Ctx<Settings>, orgId: string): Promise<Job[]> {
    if (!APOLLO_ID.test(orgId)) throw new Error("precall-research: Apollo organization id must be 24 hex characters");
    const r = await ctx.draft<any>({ platform: P, op: JOBS, summary: "read open job postings at the company",
      input: { params: { organization_id: orgId, per_page: 10 } } });
    return (Array.isArray(r.data?.organization_job_postings) ? r.data.organization_job_postings : []).slice(0, 10)
      .map((j: any): Job => ({
        title: clip(j?.title, 160), posted_at: iso(j?.posted_at),
        location: clip([j?.city, j?.state, j?.country].filter(Boolean).join(", "), 120) || undefined,
      }))
      .filter((j: Job) => j.title);
  },
};
