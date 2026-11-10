// Meta Marketing API reads for the daily ad audit, and the one queued write (campaign pause).
// Field names come from Meta's official AdsInsights spec (spend, impressions, clicks, ctr, frequency, reach,
// actions, campaign_id, campaign_name, date_start).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings, CampaignRow } from "../types.ts";

const ACCOUNT = /^act_\d{1,20}$/;
const CAMPAIGN = /^\d{1,30}$/;
const FIELDS = "campaign_id,campaign_name,spend,impressions,clicks,ctr,frequency,actions,date_start";

interface InsightRow {
  campaign_id?: string; campaign_name?: string; spend?: string; impressions?: string; clicks?: string;
  ctr?: string; frequency?: string; date_start?: string; actions?: { action_type: string; value: string }[];
}

/** Yesterday's campaign-level results for one ad account. Account ids are checked before they reach a path. */
export async function campaignInsights(ctx: Ctx<Settings>, account: string): Promise<CampaignRow[]> {
  if (!ACCOUNT.test(account)) throw new Error(`meta-ads: bad account id ${JSON.stringify(account).slice(0, 40)}`);
  const r = await ctx.draft<{ data?: InsightRow[] }>({
    platform: "meta-ads", op: "AdAccount.get.insights", summary: `yesterday's campaign results for ${account}`,
    input: { params: { "AdAccount-id": account, fields: FIELDS, level: "campaign", date_preset: "yesterday" } },
  });
  const want = new Set(ctx.settings.result_action_types ?? []);
  if (want.size === 0) throw new Error("meta-ads: result_action_types is empty, so results cannot be counted");
  const body = r.data as { data?: InsightRow[] } | undefined;   // Graph wraps the rows in { data: [...] }
  return (body?.data ?? []).filter((x) => CAMPAIGN.test(String(x.campaign_id ?? ""))).map((x): CampaignRow => ({
    account, campaign_id: String(x.campaign_id), campaign_name: String(x.campaign_name ?? "").slice(0, 200),
    date: String(x.date_start ?? ""), spend: Number(x.spend ?? 0), impressions: Number(x.impressions ?? 0),
    clicks: Number(x.clicks ?? 0), ctr: Number(x.ctr ?? 0), frequency: Number(x.frequency ?? 0),
    results: resultsOf(x.actions, want),
  }));
}

/** Results for one campaign, or null when no action row matches a result type: unknown, never zero, so nothing is paused on it. */
function resultsOf(actions: InsightRow["actions"], want: Set<string>): number | null {
  const hit = (actions ?? []).filter((a) => want.has(a.action_type));
  return hit.length ? hit.reduce((n, a) => n + Number(a.value || 0), 0) : null;
}

/** Queue a campaign pause. The approver sees it first; nothing is sent to Meta until they approve. */
export async function queuePause(ctx: Ctx<Settings>, row: CampaignRow, reason: string): Promise<string> {
  if (!CAMPAIGN.test(row.campaign_id)) throw new Error("meta-ads: bad campaign id");
  return ctx.queue({
    platform: "meta-ads", op: "Campaign.post.self", key: `pause:${row.campaign_id}:${row.date}`,
    summary: `pause "${row.campaign_name}" (${row.campaign_id}): ${reason}`,
    input: { params: { "Campaign-id": row.campaign_id }, body: { status: "PAUSED" } },
  }, `Pause ${row.campaign_name} on ${row.account}: ${reason}`);
}
