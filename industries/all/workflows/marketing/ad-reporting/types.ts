// Shared shapes for the ad-reporting workflow. The one platform this job maps in the kit is Meta's ad account, so the
// settings and the adapter speak Meta ids. Crons read and draft; a pause is only ever queued for approval.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface Settings {
  business_name?: string;
  currency?: string;                  // shown in the report, default AUD
  meta: { ad_account_id?: string };   // act_ followed by digits
  max_cost_per_lead?: number;         // an ad over this cost per lead queues a pause for approval; unset means no pauses
  min_spend_before_judging?: number;  // an ad must spend this much in the window before it can queue a pause (default 100)
  pauses_per_run?: number;            // most pauses one review run queues (default 10)
}

/** One ad's numbers for the last 7 days. Ids are checked digits; names are cleaned text. */
export interface AdRow {
  ad_id: string; ad_name: string; campaign_id: string; campaign_name: string;
  spend: number; impressions: number; clicks: number; leads: number; cost_per_lead: number | null;
}

/** Written by pull to the `spend` namespace. review reads it and never calls the platform. */
export interface Snapshot { at: string; window: "last_7d"; truncated: boolean; active: string[]; rows: AdRow[] }

export const ACCOUNT = /^act_\d{1,25}$/;
export const NUM = /^\d{1,25}$/;
export const keyOf = (s: string) => safeKey(s, 90);

/** Why the client's settings cannot run this job, or null when they can. */
export function setupProblem(s: Settings): string | null {
  if (!ACCOUNT.test(String(s.meta?.ad_account_id ?? ""))) return "settings.meta.ad_account_id is not set (expected act_ and digits)";
  if (s.max_cost_per_lead !== undefined && !(Number.isFinite(s.max_cost_per_lead) && s.max_cost_per_lead > 0)) return "settings.max_cost_per_lead must be a positive number";
  return null;
}

/** Text from the platform is data: strip control characters and cap the length before it is stored or shown. */
export const clean = (v: unknown, max = 120) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
/** A number from the platform, or 0 when it is missing or not a finite number. */
export const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
