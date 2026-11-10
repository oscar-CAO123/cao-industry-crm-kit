// Shared shapes for the work-orders workflow. This adapter uses mapped Unleashed operations.
// A work order is an Unleashed Assembly.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "unleashed";

export interface Settings {
  family: "production-plan";
  warehouse_code: string;                       // Unleashed warehouse code the plan and stock checks use
  horizon_days?: number;                        // how far ahead the production plan runs (default 30)
  production_plan: { product_code: string; units_per_day: number }[];
  components: { product_code: string; min: number; max: number }[];
  complete_when_due?: boolean;                  // queue completion of due work orders (default true)
}

export interface WorkOrder {
  guid: string; number: string; status: string; product_code: string; quantity: number; due?: string; comments?: string;
}

export interface StockLine { product_code: string; qty_on_hand: number }

export const CODE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const keyOf = (s: string) => safeKey(s, 90);
export const DAY = 864e5;
export const day = (d: Date) => d.toISOString().slice(0, 10);
