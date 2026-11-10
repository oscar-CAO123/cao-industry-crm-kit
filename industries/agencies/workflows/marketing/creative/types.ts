// Shared shapes for the creative test reader. Meta is the only platform with mapped operations so far.

export type Platform = "meta-ads";

export interface Settings {
  business_name?: string;
  meta_ads: { ad_account: string; date_preset?: string };  // "act_" followed by the numeric account id
  min_spend?: number;          // spend before an ad can be judged (default 100)
  min_ctr_percent?: number;    // an ad under this CTR, once it has spent min_spend, is a loser (default 0.5)
  max_pauses_per_run?: number; // pauses queued per review run (default 5)
}

export interface AdRow { ad_id: string; ad_name?: string; spend: number; impressions: number; clicks: number; ctr: number; cpc: number }
export interface Snapshot { at: string; rows: AdRow[] }

export const AD_ACCOUNT = /^act_\d{5,20}$/;
export const AD_ID = /^\d{5,30}$/;
export const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
