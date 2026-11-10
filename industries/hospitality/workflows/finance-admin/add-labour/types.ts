// Shared shapes for the labour alerts workflow. Deputy is the only platform adapter; the crons read Deputy,
// then work labour out and record alerts in the store. Nothing here sends or changes a live record.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "deputy";

export interface Venue { name: string; deputy_area: number; labour_target_pct: number }
export interface Settings {
  business_name?: string;
  utc_offset_hours: number;   // the venue's local time, e.g. 11 for Sydney daylight time
  min_sales?: number;         // below this many dollars of sales the share is not worked out yet (early in the day)
  venues: Venue[];
}
/** One venue's labour cost and sales for one local day, as pulled from Deputy. */
export interface Snapshot { venue: string; area: number; day: string; labour_cost: number; sales: number; pulled: string }
/** One venue's labour share for one local day. Written by the check cron; it is a record for the CRM shell, never a message. */
export interface Alert {
  venue: string; area: number; day: string; labour_pct: number | null; target_pct: number;
  status: "open" | "ok" | "waiting-for-data"; raised?: string; checked: string;
}

export const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const localDay = (now: Date, offsetHours: number) => new Date(now.getTime() + offsetHours * 3600e3).toISOString().slice(0, 10);
export const dayKey = (area: number, day: string) => `area-${area}:${day}`;
export const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
export type LabourCtx = Ctx<Settings>;
