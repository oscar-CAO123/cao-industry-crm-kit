// Shared shapes for the lost-deal review workflow. The crons read lost and won deals, draft a review record for each
// lost deal, roll the reasons up, and queue any re-open for a person to approve.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "gohighlevel";

export interface Settings {
  business_name?: string;
  locationId: string;              // GoHighLevel sub-account (location) id
  pipeline_id?: string;            // optional: review one pipeline only
  nurture_reason_ids?: string[];   // lost reasons the owner wants re-opened for another try
  nurture_within_days?: number;    // re-open only deals lost within this many days (default 90)
  rollup_days?: number;            // window for the roll-up (default 90)
}

export interface Deal {
  id: string; name: string; value: number; status: "lost" | "won";
  changed_at: string; created_at?: string; lost_reason_id?: string; pipeline_id?: string;
}
export interface Review {
  deal_id: string; name: string; value: number; lost_at: string; reason: string;
  status: "to-review"; drafted: string;
}
export interface Rollup {
  day: string; window_days: number; lost: number; lost_value: number; won: number; win_rate: number | null;
  no_reason: number; top_reasons: { reason: string; count: number; value: number }[];
}

export const DAY = 864e5;
export const GHL_ID = /^[A-Za-z0-9]{8,64}$/;
export const keyOf = (s: string) => safeKey(s, 90);
export const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const ghlId = (v: unknown, what: string): string => {
  const s = String(v ?? "");
  if (!GHL_ID.test(s)) throw new Error(`gohighlevel: bad ${what}`);
  return s;
};
export type Ctx_ = Ctx<Settings>;
