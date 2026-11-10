// Shared shapes for the marketing-data workflow. One mapped platform so far (Meta Ads); the other places the job
// names (website, search, leads, the practice system) are listed in workflow.json gaps, not wired here.

export type Platform = "meta-ads";

export const WINDOWS = ["last_7d", "last_14d", "last_30d"] as const;
export type Window = (typeof WINDOWS)[number];

export interface Settings {
  business_name?: string;
  currency?: string;
  meta: { ad_account_id: string };   // act_<digits>, the firm's own ad account
  window?: Window;
}

export interface CampaignRow {
  campaign_id: string;
  campaign_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  cost_per_lead: number | null;
  date_start: string;
  date_stop: string;
}
export interface Snapshot { at: string; window: Window; truncated: boolean; rows: CampaignRow[] }
export interface Report {
  at: string; window: Window; currency: string; from_snapshot: string;
  total_spend: number; total_leads: number; blended_cost_per_lead: number | null;
  campaigns: CampaignRow[]; partial: boolean; not_covered: string;
}

export const ACCOUNT = /^act_\d{5,20}$/;
export const NUM = /^\d{1,20}$/;

/** A number from outside, or 0 when it is not one. Meta sends money and counts as strings. */
export const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
/** A label from outside: control characters out, length capped. The report is data, never HTML. */
export const clean = (v: unknown): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
export const money = (n: number) => `$${n.toFixed(2)}`;

/** Why the settings cannot run, or null when they can. Checked before any network call. */
export function setupProblem(s: Settings | undefined): string | null {
  if (!s?.meta?.ad_account_id || !ACCOUNT.test(String(s.meta.ad_account_id))) return "meta.ad_account_id must look like act_1234567890";
  if (s.window !== undefined && !(WINDOWS as readonly string[]).includes(s.window)) return `window must be one of ${WINDOWS.join(", ")}`;
  return null;
}
export const windowOf = (s: Settings): Window => s.window ?? "last_7d";
