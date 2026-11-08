// Meta ads (Facebook): the one adapter this job maps. Reads run on their own. Every create is a live operation, so the
// build cron only ever queues it, and the approval runs it. Field names come from the raw Meta spec in the endpoint map:
// Campaign (name, objective, status, special_ad_categories), AdSet (campaign_id, daily_budget, billing_event,
// optimization_goal, targeting, promoted_object), AdCreative (object_story_spec.link_data), Ad (adset_id, creative, status).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { CampaignPlan, Settings, Step } from "../types.ts";
import { NUM } from "../types.ts";

const P = "meta-ads";

/** The create act for one step. ids holds what the steps before it created. Every object is created PAUSED. */
export function createAct(s: Settings, p: CampaignPlan, step: Step, ids: Partial<Record<Step, string>>, key: string): Act {
  const base = { "AdAccount-id": s.meta.ad_account_id! };
  const lead = p.objective === "OUTCOME_LEADS";
  const countries = s.countries ?? ["AU"];
  if (step === "campaign") {
    return { platform: P, op: "AdAccount.post.campaigns", key, summary: `Meta campaign ${p.name} (created PAUSED)`,
      input: { params: { ...base, name: p.name, objective: p.objective, status: "PAUSED", special_ad_categories: [] } } };
  }
  if (step === "adset") {
    if (!NUM.test(ids.campaign ?? "")) throw new Error("meta-ads: the campaign id is not set yet");
    return { platform: P, op: "AdAccount.post.adsets", key, summary: `Meta ad set for ${p.name} (created PAUSED)`,
      input: { params: { ...base, name: `${p.name} ad set`, campaign_id: ids.campaign, status: "PAUSED",
        daily_budget: p.daily_budget_minor, billing_event: "IMPRESSIONS",
        optimization_goal: lead ? "LEAD_GENERATION" : "LINK_CLICKS",
        targeting: { geo_locations: { countries }, age_min: p.age_min ?? 18, age_max: p.age_max ?? 65 },
        ...(lead ? { promoted_object: { page_id: s.meta.page_id } } : {}) } } };
  }
  if (step === "creative") {
    const cta = lead ? { type: "SIGN_UP", value: { lead_gen_form_id: p.lead_gen_form_id } } : { type: "LEARN_MORE", value: { link: p.link } };
    return { platform: P, op: "AdAccount.post.adcreatives", key, summary: `Meta creative for ${p.name}`,
      input: { params: { ...base, name: `${p.name} creative`, object_story_spec: { page_id: s.meta.page_id,
        link_data: { link: p.link, message: p.message, name: p.headline, picture: p.image_url, call_to_action: cta } } } } };
  }
  if (!NUM.test(ids.adset ?? "") || !NUM.test(ids.creative ?? "")) throw new Error("meta-ads: the ad set or creative id is not set yet");
  return { platform: P, op: "AdAccount.post.ads", key, summary: `Meta ad for ${p.name} (created PAUSED)`,
    input: { params: { ...base, name: p.name, adset_id: ids.adset, creative: { creative_id: ids.creative }, status: "PAUSED" } } };
}

/** Read: last seven days per campaign, from the ad account's own insights. Reads only. */
export async function campaignResults(ctx: Ctx<Settings>, s: Settings) {
  const r = await ctx.draft<any>({ platform: P, op: "AdAccount.get.insights", summary: "campaign results, last 7 days",
    input: { params: { "AdAccount-id": s.meta.ad_account_id!, level: "campaign", date_preset: "last_7d",
      fields: "campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,actions" } } });
  if (r.status >= 300) throw new Error(`meta-ads: campaign results failed with status ${r.status}`);
  return ((r.data?.data ?? []) as any[]).slice(0, 50).map((x) => ({
    campaign_id: String(x?.campaign_id ?? "").slice(0, 40),
    campaign_name: String(x?.campaign_name ?? "").slice(0, 100),
    spend: String(x?.spend ?? "0"), impressions: String(x?.impressions ?? "0"), clicks: String(x?.clicks ?? "0"),
    results: resultCount(x?.actions),
  }));
}

function resultCount(actions: unknown): number {
  const a = Array.isArray(actions) ? actions.find((x: any) => x?.action_type === "lead" || x?.action_type === "link_click") : undefined;
  return Number((a as any)?.value ?? 0) || 0;
}
