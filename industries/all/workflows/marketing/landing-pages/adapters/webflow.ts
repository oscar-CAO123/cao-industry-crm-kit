// Webflow: the site's pages and forms (reads), and a page change queued as one approval: the content update, then the
// publish of that page. Field names come from the Webflow v2 spec in the endpoint map (pages list, forms list,
// form submissions, pages/{page_id}/dom, sites/{site_id}/publish).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Change, type FormRow, type PageRow, type Settings, WEBFLOW_ID, arr, checked, iso } from "../types.ts";

const P = "webflow";
const cfg = (s: Settings) => {
  if (!s.webflow) throw new Error("landing-pages: settings.webflow is not set");
  return s.webflow;
};
const site = (s: Settings) => checked(cfg(s).site_id, WEBFLOW_ID, "webflow site id");

export const webflow = {
  /** The site's pages and forms. Reads only. One page of 100 each; a larger site needs paging added. */
  async inventory(ctx: Ctx<Settings>): Promise<{ pages: PageRow[]; forms: FormRow[] }> {
    const siteId = site(ctx.settings);
    const seen = ctx.now.toISOString();
    const p = await ctx.draft<any>({ platform: P, op: "2.pages_list", summary: "list pages", input: { params: { site_id: siteId, limit: 100 } } });
    const f = await ctx.draft<any>({ platform: P, op: "2.forms_list", summary: "list forms", input: { params: { site_id: siteId, limit: 100 } } });
    return {
      pages: arr(p.data?.pages).filter((x) => WEBFLOW_ID.test(String(x?.id)))
        .map((x): PageRow => ({ platform: P, id: String(x.id), name: String(x.title ?? x.slug ?? x.id).slice(0, 200), seen })),
      forms: arr(f.data?.forms).filter((x) => WEBFLOW_ID.test(String(x?.id)))
        .map((x): FormRow => ({ platform: P, id: String(x.id), name: String(x.displayName ?? x.id).slice(0, 200), seen })),
    };
  },

  /** How many submissions a form got since a time (the first 100 it returns). Reads only. */
  async submissions(ctx: Ctx<Settings>, form: FormRow, since: string): Promise<number> {
    const r = await ctx.draft<any>({ platform: P, op: "2.forms_list-submissions", summary: `submissions for ${form.name}`,
      input: { params: { site_id: site(ctx.settings), form_id: checked(form.id, WEBFLOW_ID, "webflow form id"), limit: 100 } } });
    const from = Date.parse(since);
    return arr(r.data?.formSubmissions).filter((x) => Date.parse(String(x?.dateSubmitted)) >= from).length;
  },

  /** The live acts for one change: the content update, then (when asked) the publish of that page. Both are live operations. */
  acts(ctx: Ctx<Settings>, c: Change, key: string): Act[] {
    const w = cfg(ctx.settings);
    const acts: Act[] = [{ platform: P, op: "2.pages_update-static-content", key, summary: `update content of page ${c.page_id}`,
      input: { params: { page_id: c.page_id, localeId: w.locale_id }, body: { nodes: c.nodes } } }];
    if (c.publish) acts.push({ platform: P, op: "2.sites_publish", summary: `publish page ${c.page_id}`,
      input: { body: { pageId: c.page_id, customDomains: w.custom_domain_ids ?? [], publishToWebflowSubdomain: !(w.custom_domain_ids?.length) },
        params: { site_id: site(ctx.settings) } } });
    return acts;
  },
};
