// Meta ads (the ad account): the one adapter this job maps in the kit. Reads are drafts; a pause is live, so it is only
// ever passed to ctx.queue. Field names come from the raw Meta spec in the endpoint map: AdsInsights (spend, impressions,
// clicks, actions with action_type "lead") and Ad (status, PAUSED is a valid adgroup_status).
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import type { AdRow, Settings } from "../types.ts";
import { NUM, clean, num, keyOf } from "../types.ts";

const P = "meta-ads";
const ok = (r: { status: number }, what: string) => { if (r.status >= 300) throw new Error(`meta-ads: ${what} failed with status ${r.status}`); };

export const meta = {
  /** Draft: spend, clicks and leads for every ad with delivery in the last 7 days. Reads only. */
  async adInsights(ctx: Ctx<Settings>, accountId: string): Promise<{ rows: AdRow[]; truncated: boolean }> {
    const r = await ctx.draft<any>({ platform: P, op: "AdAccount.get.insights", summary: "ad-level spend and leads, last 7 days",
      input: { params: { "AdAccount-id": accountId, level: "ad", date_preset: "last_7d", limit: 100,
        fields: "ad_id,ad_name,campaign_id,campaign_name,spend,impressions,clicks,actions" } } });
    ok(r, "ad insights");
    const data: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    const rows: AdRow[] = [];
    for (const x of data.slice(0, 100)) {
      const ad_id = String(x?.ad_id ?? ""), campaign_id = String(x?.campaign_id ?? "");
      if (!NUM.test(ad_id) || !NUM.test(campaign_id)) continue;   // an id that is not digits never reaches a path or a pause
      const leads = (Array.isArray(x.actions) ? x.actions : []).filter((a: any) => a?.action_type === "lead")
        .reduce((n: number, a: any) => n + num(a.value), 0);
      const spend = num(x.spend);
      rows.push({ ad_id, ad_name: clean(x.ad_name), campaign_id, campaign_name: clean(x.campaign_name),
        spend, impressions: num(x.impressions), clicks: num(x.clicks), leads, cost_per_lead: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null });
    }
    return { rows, truncated: !!r.data?.paging?.next || data.length > 100 };
  },

  /** Draft: the ids of ads that are running now. Reads only. A second page means the list is partial. */
  async activeAdIds(ctx: Ctx<Settings>, accountId: string): Promise<{ ids: string[]; truncated: boolean }> {
    const r = await ctx.draft<any>({ platform: P, op: "AdAccount.get.ads", summary: "ads running now",
      input: { params: { "AdAccount-id": accountId, effective_status: ["ACTIVE"] } } });
    ok(r, "active ads");
    const data: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    return { ids: data.map((x) => String(x?.id ?? "")).filter((x) => NUM.test(x)), truncated: !!r.data?.paging?.next };
  },

  /** The live act that pauses one ad. Only ever passed to ctx.queue; a person approves it in the CRM shell. */
  pauseAct(adId: string, why: string): Act {
    return { platform: P, op: "Ad.post.self", key: keyOf(`pause:${adId}`), summary: `pause ad ${adId}: ${why}`,
      input: { params: { "Ad-id": adId, status: "PAUSED" } } };
  },
};
