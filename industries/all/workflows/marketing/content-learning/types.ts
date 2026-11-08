// Shared shapes for the content-learning workflow. Meta (the ad account and the Instagram account) is the one platform the
// kit maps for this job. Crons read and draft; a pause is only ever queued for approval.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface Settings {
  business_name?: string;
  currency?: string;                    // shown in the scorecard, default AUD
  meta: { ad_account_id?: string; instagram_user_id?: string };
  window?: "last_7d" | "last_30d";      // the ad window, default last_30d
  min_spend_before_judging?: number;    // an ad must spend this much before it is scored (default 100)
  min_reach_before_judging?: number;    // a post must reach this many accounts before it is scored (default 200)
  max_cost_per_lead?: number;           // a running ad over this queues a pause; unset means no pauses and scores use the median
  pauses_per_run?: number;              // most pauses one score run queues (default 5)
  history_limit?: number;               // Instagram posts read per run (default 25, at most 50)
}

/** One ad's results for the window. Ids are checked digits; names are cleaned text. */
export interface AdPerf {
  kind: "ad"; id: string; name: string; campaign: string;
  spend: number; impressions: number; clicks: number; ctr: number; leads: number; cost_per_lead: number | null;
  running: boolean;
}

/** One Instagram post's results. engagement_rate is interactions divided by reach, or null when reach is zero. */
export interface PostPerf {
  kind: "instagram"; id: string;
  reach: number; likes: number; comments: number; saves: number; shares: number; engagement_rate: number | null;
}

/** Written by pull to the `performance` namespace. score reads it and never calls the platform. */
export interface Snapshot { at: string; window: "last_7d" | "last_30d"; ads: AdPerf[]; posts: PostPerf[]; partial: boolean }

export interface Scored {
  kind: "ad" | "instagram"; id: string; name: string;
  band: "working" | "not working" | "too early";
  measure: string;   // plain words, for the owner
  rank: number;      // higher is better within a kind: negative cost per lead for ads, engagement rate for posts
}

/** Written by score to the `scores` namespace: every scored item, and the plan that feeds the next brief. */
export interface Scorecard {
  at: string; from_snapshot: string; partial: boolean;
  items: Scored[];
  plan: { make_more: Scored[]; fix_or_stop: Scored[]; too_early: number };
  pauses_awaiting_approval: string[];
  not_covered: string;
}

export const ACCOUNT = /^act_\d{1,25}$/;
export const NUM = /^\d{1,25}$/;
export const keyOf = (s: string) => safeKey(s, 90);

/** Why the client's settings cannot run this job, or null when they can. */
export function setupProblem(s: Settings): string | null {
  const acct = s.meta?.ad_account_id, ig = s.meta?.instagram_user_id;
  if (!acct && !ig) return "set settings.meta.ad_account_id, settings.meta.instagram_user_id, or both";
  if (acct && !ACCOUNT.test(String(acct))) return "settings.meta.ad_account_id must be act_ followed by digits";
  if (ig && !NUM.test(String(ig))) return "settings.meta.instagram_user_id must be digits";
  if (s.window !== undefined && s.window !== "last_7d" && s.window !== "last_30d") return "settings.window must be last_7d or last_30d";
  if (s.max_cost_per_lead !== undefined && !(Number.isFinite(s.max_cost_per_lead) && s.max_cost_per_lead > 0)) return "settings.max_cost_per_lead must be a positive number";
  return null;
}

/** Text from the platform is data: strip control characters and cap the length before it is stored or shown. */
export const clean = (v: unknown, max = 120) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
/** A number from the platform, or 0 when it is missing or not a finite number. */
export const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
export const money = (n: number) => `$${n.toFixed(2)}`;
/** The median of a list of numbers, or null for an empty list. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
