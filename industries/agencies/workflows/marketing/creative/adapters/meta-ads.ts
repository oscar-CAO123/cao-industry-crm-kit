// Meta ads: read the account's ad insights and active ads (draft operations), and queue a pause (a live operation).
// Field names come from the Meta ops file and the vendor spec (AdsInsights: ad_id, ad_name, spend, impressions, clicks, ctr, cpc).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type AdRow, AD_ACCOUNT, AD_ID, num } from "../types.ts";

const P = "meta-ads";
const FIELDS = "ad_id,ad_name,spend,impressions,clicks,ctr,cpc";

export function accountOf(s: Settings): string {
  const a = s.meta_ads?.ad_account ?? "";
  if (!AD_ACCOUNT.test(a)) throw new Error("meta_ads.ad_account must look like act_ followed by digits");
  return a;
}

/** Per-ad performance for the reporting period (draft operation: a read). */
export async function insights(ctx: Ctx<Settings>): Promise<AdRow[]> {
  const r = await ctx.draft<any>({ platform: P, op: "AdAccount.get.insights", summary: "read ad insights", input: { params: {
    "AdAccount-id": accountOf(ctx.settings), level: "ad", date_preset: ctx.settings.meta_ads.date_preset ?? "last_7d", fields: FIELDS, limit: 500 } } });
  return (r.data?.data ?? []).filter((x: any) => AD_ID.test(String(x.ad_id ?? ""))).map((x: any): AdRow => ({
    ad_id: String(x.ad_id), ad_name: String(x.ad_name ?? "").slice(0, 120) || undefined,
    spend: num(x.spend), impressions: num(x.impressions), clicks: num(x.clicks), ctr: num(x.ctr), cpc: num(x.cpc) }));
}

/** Ids of ads that are running right now (draft operation: a read). */
export async function activeAdIds(ctx: Ctx<Settings>): Promise<Set<string>> {
  const r = await ctx.draft<any>({ platform: P, op: "AdAccount.get.ads", summary: "read active ads", input: { params: {
    "AdAccount-id": accountOf(ctx.settings), effective_status: ["ACTIVE"] } } });
  return new Set((r.data?.data ?? []).map((x: any) => String(x.id ?? "")).filter((id: string) => AD_ID.test(id)));
}

/** The pause, as a live act: it is only ever queued for a person to approve. */
export function pauseAct(adId: string) {
  if (!AD_ID.test(adId)) throw new Error("meta-ads: bad ad id");
  return { platform: P, op: "Ad.post.self", input: { params: { "Ad-id": adId }, body: { status: "PAUSED" } }, summary: `pause ad ${adId}`, key: `pause:${adId}` };
}
