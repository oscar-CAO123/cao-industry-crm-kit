// Shared shapes for the market-forecasting workflow. Both adapters speak these.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "xero" | "microsoft-365";

export interface Table { drive: string; item: string; table: string }
export interface Settings {
  business_name?: string;
  summary_to: string;                       // the owner's address for the monthly forecast summary (a draft until sent)
  microsoft_365: {
    mailbox: string;                        // the client's own mailbox
    folder?: string;                        // Outlook folder to read buyer enquiries from (default inbox)
    search?: string;                        // word that marks a buyer enquiry (default "order")
    price_table?: Table;                    // Excel table: Code | Name | Unit | Price (overrides Xero item prices when set)
    register?: Table;                       // Excel table the forecast and price log rows go into
  };
  forecast_months?: number;                 // trailing complete months averaged (1 to 12, default 3)
  price_alert_percent?: number;             // flag a list price this far from the last invoiced price (default 5)
}

export interface SaleLine { id: string; date: string; code: string; name: string; qty: number; unit: number; buyer: string }
export interface Enquiry { id: string; title: string; from: string; received: string; preview: string }
export interface Item { code: string; name: string; price: number }
/** One comparison of a list price against the last invoiced price for the same item. */
export interface PriceCheck { code: string; name: string; last: number; list: number; pct: number; checked: string }

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const keyOf = (s: string) => safeKey(s, 90);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const num = (n: number) => Math.round(n * 10) / 10;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const ym = (d: Date) => d.toISOString().slice(0, 7);
/** The n complete calendar months before the month of `now`, as YYYY-MM. */
export function priorMonths(now: Date, n: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) out.push(ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}
/** First day of the month `n` months before `now`, as YYYY-MM-DD. */
export const since = (now: Date, n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)).toISOString().slice(0, 10);
export const months = (s: Settings) => Math.min(12, Math.max(1, Math.floor(Number(s.forecast_months ?? 3)) || 3));
export const alertAt = (s: Settings) => Math.min(100, Math.max(1, Number(s.price_alert_percent ?? 5) || 5));

export type { Ctx };
