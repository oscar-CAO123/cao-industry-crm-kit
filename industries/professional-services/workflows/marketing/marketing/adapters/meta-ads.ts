// Meta ads (the firm's ad account): the one adapter this job maps. Campaign-level insights for a window, read only.
// Field names come from the vendor's AdsInsights spec (campaign_id, campaign_name, spend, impressions, clicks,
// actions with action_type "lead", date_start, date_stop). Nothing here changes an ad.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type CampaignRow, type Settings, type Window, NUM, clean, num } from "../types.ts";

const P = "meta-ads";

export const meta = {
  /** Draft (read): spend, clicks and leads per campaign for the window. Returns the rows and whether the list is partial. */
  async campaignInsights(ctx: Ctx<Settings>, accountId: string, window: Window): Promise<{ rows: CampaignRow[]; truncated: boolean }> {
    const r = await ctx.draft<any>({ platform: P, op: "AdAccount.get.insights", summary: `campaign spend and leads, ${window}`,
      input: { params: { "AdAccount-id": accountId, level: "campaign", date_preset: window, limit: 100,
        fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,date_start,date_stop" } } });
    if (r.status >= 300) throw new Error(`meta-ads: campaign insights failed with status ${r.status}`);
    const data: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    const rows: CampaignRow[] = [];
    for (const x of data.slice(0, 100)) {
      const campaign_id = String(x?.campaign_id ?? "");
      if (!NUM.test(campaign_id)) continue;   // an id that is not digits never reaches the store as a key
      const leads = (Array.isArray(x.actions) ? x.actions : [])
        .filter((a: any) => a?.action_type === "lead")
        .reduce((n: number, a: any) => n + num(a.value), 0);
      const spend = num(x.spend);
      rows.push({
        campaign_id, campaign_name: clean(x.campaign_name), spend,
        impressions: num(x.impressions), clicks: num(x.clicks), leads,
        cost_per_lead: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null,
        date_start: String(x.date_start ?? "").slice(0, 10), date_stop: String(x.date_stop ?? "").slice(0, 10),
      });
    }
    return { rows, truncated: !!r.data?.paging?.next || data.length > 100 };
  },
};
