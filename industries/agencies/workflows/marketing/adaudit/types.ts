// Shapes for the daily ad audit. Crons read Meta insights, compare them with thresholds, and queue pauses for approval.
export interface Settings {
  agency: string;
  meta_accounts: string[];              // ad account ids, act_<digits>
  result_action_types: string[];        // action types that count as a result, for example "lead" or "purchase"
  thresholds: {
    frequency_max: number; ctr_min_pct: number; pacing_min_pct: number; pacing_max_pct: number; pause_spend_without_results_usd: number;
  };
  daily_budget_usd?: Record<string, number>;
}

export interface CampaignRow {
  account: string;
  campaign_id: string;
  campaign_name: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  frequency: number;
  results: number;
}

export interface Finding { account: string; campaign_id?: string; kind: "frequency" | "ctr" | "pacing" | "spend-without-results"; detail: string }
