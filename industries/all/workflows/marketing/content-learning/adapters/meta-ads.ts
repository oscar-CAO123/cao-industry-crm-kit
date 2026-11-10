// Meta (the ad account and the Instagram account): the one platform this job maps in the kit. Reads are drafts. A pause is
// live, so it is only ever passed to ctx.queue. Field names come from the raw Meta spec in the endpoint map: AdsInsights
// (ad_id, ad_name, spend, clicks, ctr, actions with action_type "lead") and the InsightsResult metric enum for Instagram media.
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import type { AdPerf, PostPerf, Settings } from "../types.ts";
import { NUM, clean, num, keyOf } from "../types.ts";

const P = "meta-ads";
/** Instagram media insights used for scoring. Support varies by media type, so confirm each one on a live account. */
export const MEDIA_METRICS = "reach,likes,comments,saved,shares";

const ok = (r: { status: number }, what: string) => { if (r.status >= 300) throw new Error(`meta-ads: ${what} failed with status ${r.status}`); };

export const meta = {
  /** Draft: results for every ad with delivery in the window, one row per ad. Reads only. */
  async adPerformance(ctx: Ctx<Settings>, accountId: string, window: string): Promise<{ ads: AdPerf[]; truncated: boolean }> {
    const r = await ctx.draft<any>({ platform: P, op: "AdAccount.get.insights", summary: `ad-level results, ${window}`,
      input: { params: { "AdAccount-id": accountId, level: "ad", date_preset: window, limit: 100,
        fields: "ad_id,ad_name,campaign_name,spend,impressions,clicks,ctr,actions" } } });
    ok(r, "ad insights");
    const data: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    const ads: AdPerf[] = [];
    for (const x of data.slice(0, 100)) {
      const id = String(x?.ad_id ?? "");
      if (!NUM.test(id)) continue;   // an id that is not digits never reaches a path or a pause
      const leads = (Array.isArray(x.actions) ? x.actions : []).filter((a: any) => a?.action_type === "lead")
        .reduce((n: number, a: any) => n + num(a.value), 0);
      const spend = num(x.spend);
      ads.push({ kind: "ad", id, name: clean(x.ad_name), campaign: clean(x.campaign_name),
        spend, impressions: num(x.impressions), clicks: num(x.clicks), ctr: num(x.ctr), leads,
        cost_per_lead: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null, running: false });
    }
    return { ads, truncated: !!r.data?.paging?.next || data.length > 100 };
  },

  /** Draft: the ids of ads running now. Reads only. A second page means the list is partial. */
  async runningAdIds(ctx: Ctx<Settings>, accountId: string): Promise<{ ids: string[]; truncated: boolean }> {
    const r = await ctx.draft<any>({ platform: P, op: "AdAccount.get.ads", summary: "ads running now",
      input: { params: { "AdAccount-id": accountId, effective_status: ["ACTIVE"] } } });
    ok(r, "running ads");
    const data: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    return { ids: data.map((x) => String(x?.id ?? "")).filter((x) => NUM.test(x)), truncated: !!r.data?.paging?.next };
  },

  /** Draft: reach and interactions for the most recent Instagram posts. Reads only. A post whose insights fail is left out and the run is marked partial. */
  async instagramPosts(ctx: Ctx<Settings>, igUserId: string, limit: number): Promise<{ posts: PostPerf[]; partial: boolean }> {
    const list = await ctx.draft<any>({ platform: P, op: "IGUser.get.media", summary: "recent Instagram posts",
      input: { params: { "IGUser-id": igUserId } } });
    ok(list, "Instagram media list");
    const all: any[] = Array.isArray(list.data?.data) ? list.data.data : [];
    const ids = all.map((x) => String(x?.id ?? "")).filter((x) => NUM.test(x)).slice(0, limit);
    const posts: PostPerf[] = [];
    let partial = !!list.data?.paging?.next || all.length > limit;
    for (const id of ids) {
      let data: any;
      try {
        const r = await ctx.draft<any>({ platform: P, op: "IGMedia.get.insights", summary: `insights for Instagram post ${id}`,
          input: { params: { "IGMedia-id": id, metric: MEDIA_METRICS } } });
        data = r.data;
      } catch (e: any) {
        // A bad token stops the run; one post whose insights are refused is left out and the run is marked partial.
        if (e?.status === 401 || e?.status === 403) throw e;
        partial = true;
        continue;
      }
      const v: Record<string, number> = {};
      for (const m of Array.isArray(data?.data) ? data.data : []) v[String(m?.name ?? "")] = num(m?.values?.[0]?.value);
      const g = (k: string) => v[k] ?? 0;
      const interactions = g("likes") + g("comments") + g("saved") + g("shares");
      const reach = g("reach");
      posts.push({ kind: "instagram", id, reach, likes: g("likes"), comments: g("comments"), saves: g("saved"), shares: g("shares"),
        engagement_rate: reach > 0 ? Math.round((interactions / reach) * 10000) / 10000 : null });
    }
    return { posts, partial };
  },

  /** The live act that pauses one ad. Only ever passed to ctx.queue; a person approves it in the CRM shell. */
  pauseAct(adId: string, why: string, since: string): Act {
    return { platform: P, op: "Ad.post.self", key: keyOf(`pause:${adId}:${since}`), summary: `pause ad ${adId}: ${why}`,
      input: { params: { "Ad-id": adId, status: "PAUSED" } } };
  },
};
