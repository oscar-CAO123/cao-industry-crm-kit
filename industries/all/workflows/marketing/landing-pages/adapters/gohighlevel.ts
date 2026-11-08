// GoHighLevel: funnels, their pages and forms, and form submissions. Reads only: the kit maps no build or publish
// operation for funnels (AI Studio and Funnel AI are not mapped), so this adapter never changes a page. Field names come
// from the GoHighLevel spec in the endpoint map (funnels, forms, submissions).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type FormRow, type PageRow, type Settings, GHL_ID, arr, checked, iso } from "../types.ts";

const P = "gohighlevel";
const loc = (s: Settings) => {
  if (!s.gohighlevel) throw new Error("landing-pages: settings.gohighlevel is not set");
  return checked(s.gohighlevel.location_id, GHL_ID, "gohighlevel location id");
};

export const gohighlevel = {
  /** The funnels, their pages and the forms in the sub-account. Reads only. Stops at 20 funnels per run. */
  async inventory(ctx: Ctx<Settings>): Promise<{ pages: PageRow[]; forms: FormRow[] }> {
    const locationId = loc(ctx.settings);
    const seen = ctx.now.toISOString();
    const f = await ctx.draft<any>({ platform: P, op: "funnels.getFunnels", summary: "list funnels", input: { params: { locationId, limit: "100" } } });
    const pages: PageRow[] = [];
    for (const fn of arr(f.data?.funnels).filter((x) => GHL_ID.test(String(x?._id))).slice(0, 20)) {
      const funnelId = String(fn._id);
      const r = await ctx.draft<any>({ platform: P, op: "funnels.getPagesByFunnelId", summary: `pages of ${fn.name ?? funnelId}`,
        input: { params: { locationId, funnelId, limit: 100, offset: 0 } } });
      for (const pg of arr(r.data)) {
        if (GHL_ID.test(String(pg?._id))) pages.push({ platform: P, id: String(pg._id), name: String(pg.name ?? pg._id).slice(0, 200), seen });
      }
    }
    const fr = await ctx.draft<any>({ platform: P, op: "forms.get-forms", summary: "list forms", input: { params: { locationId, limit: 100 } } });
    const forms = arr(fr.data?.forms).filter((x) => GHL_ID.test(String(x?.id)))
      .map((x): FormRow => ({ platform: P, id: String(x.id), name: String(x.name ?? x.id).slice(0, 200), seen }));
    return { pages, forms };
  },

  /** How many submissions a form got between a time and now (the first 100 it returns). Reads only. */
  async submissions(ctx: Ctx<Settings>, form: FormRow, since: string): Promise<number> {
    const r = await ctx.draft<any>({ platform: P, op: "forms.get-forms-submissions", summary: `submissions for ${form.name}`,
      input: { params: { locationId: loc(ctx.settings), formId: checked(form.id, GHL_ID, "gohighlevel form id"), startAt: since, endAt: iso(ctx.now), limit: 100 } } });
    return arr(r.data?.submissions).length;
  },
};
