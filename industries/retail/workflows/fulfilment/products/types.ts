// Shared shapes for the product data pipeline. Every adapter speaks these, so a cron can read any mapped platform.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "unleashed" | "woocommerce";

export interface Settings {
  family: "all";
  business_name?: string;
  low_stock_qty?: number;      // total on hand at or below this is flagged
  retire_codes?: string[];     // product codes the owner has listed for retirement
  woocommerce?: boolean;       // also read the WooCommerce store's products
}

export interface Product {
  platform: Platform;
  code: string;                // Unleashed ProductCode, or the WooCommerce SKU (or #id when none)
  guid?: string;               // Unleashed Guid, or the WooCommerce id
  name?: string;
  barcode?: string;            // Unleashed only: WooCommerce barcode is not mapped
  sku?: string;                // WooCommerce only
  price?: number;              // Unleashed DefaultSellPrice, WooCommerce regular_price
  obsolete?: boolean;
}

export interface StockLevel { code: string; guid?: string; warehouse?: string; qty: number }

/** A flag a cron raises into its own store. It records a problem for a person to fix; it changes nothing on a platform. */
export interface Flag {
  key: string;
  kind: "check" | "stock";
  platform: Platform;
  code: string;
  reason: string;
  message: string;
  first_seen: string;
  last_seen: string;
  status: "open" | "resolved";
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CODE = /^[A-Za-z0-9 ._\/-]{1,100}$/;

/** Platform text as plain, bounded text: control characters out, length capped. */
export const text = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
export const num = (v: unknown) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) ? n : undefined; };
export const flagKey = (kind: string, platform: string, code: string, reason: string) => safeKey(`${kind}.${platform}.${code}.${reason}`);
