// Shared shapes for the comp and discount watch. Square is the only platform adapter. The watch cron reads Square's
// paid sales and their discounts; the report cron counts the day's records from the store. Nothing here sends or
// changes a sale.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "square";

export interface Venue { name: string; square_location_id: string }
export interface Settings {
  business_name?: string;
  utc_offset_hours: number;      // the venue's local time, e.g. 11 for Sydney daylight time
  review_over_pct?: number;      // a percentage discount above this is flagged; default 10
  allowed_discounts?: string[];  // discount names the business accepts; any other name is flagged
  venues: Venue[];
}
export interface Discount { name: string; pct: number | null; dollars: number; scope?: string }
/** One paid sale, written by the watch cron. A flagged sale is also kept under flags, with its reasons. */
export interface OrderRecord {
  venue: string; order_id: string; created: string; day: string; discount_dollars: number;
  discounts: Discount[]; flagged: boolean; reasons: string[]; team_member_id?: string; checked: string;
}
export interface Watermark { since: string }
export interface DailyReport {
  day: string; written: string;
  venues: { venue: string; orders: number; discounted: number; flagged: number; discount_dollars: number }[];
}

export const LOC = /^[A-Za-z0-9]{1,40}$/;
export const ORDER_ID = /^[A-Za-z0-9_-]{1,120}$/;
export const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);
export const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
/** The venue's local calendar day for an ISO time. */
export const localDay = (iso: string, offsetHours: number) => new Date(Date.parse(iso) + offsetHours * 3600e3).toISOString().slice(0, 10);
export type CompCtx = Ctx<Settings>;
