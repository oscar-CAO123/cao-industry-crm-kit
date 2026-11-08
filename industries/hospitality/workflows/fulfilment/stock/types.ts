// Shared shapes for the hand-count drinks workflow. The one platform adapter (Square) speaks these.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "square";

export interface Settings {
  family?: "hand-count";
  business_name?: string;
  locations?: string[];      // Square location ids to count; empty means every active location the token can see
  max_variations?: number;   // most tracked items one snapshot reads (capped at 400)
}

/** Square ids: letters, digits, underscore and hyphen. Checked before any id reaches a path, a filter or a store key. */
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A count id starts with a letter or digit, so it is also a valid store key. */
export const COUNT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,89}$/;
/** A quantity Square accepts: whole bottles or fractions of one, up to three decimals. */
export const QTY_TEXT = /^\d{1,9}(\.\d{1,3})?$/;

export interface CountLine { catalog_object_id: string; name: string; quantity: number }
export interface Count {
  id: string; location_id: string; taken_at: string; lines: CountLine[];
  status: "new" | "rejected" | "reconciled" | "queued" | "posted";
  reason?: string; reconciled_at?: string; differences?: number; approval?: string;
}
export interface StockLevel { location_id: string; catalog_object_id: string; name: string; quantity: string; calculated_at?: string; seen_at: string }
export interface Variance { count: string; location_id: string; catalog_object_id: string; name: string; hand_count: number; system_count: number | null; difference: number | null }

export const keyOf = (s: string) => safeKey(s, 90);
export const qtyText = (q: number) => String(Math.round(q * 1000) / 1000);

/** Why a count cannot be reconciled, or undefined when it is sound. Runs before any network call. */
export function countProblem(c: Count): string | undefined {
  if (!COUNT_ID.test(String(c.id ?? ""))) return "bad count id";
  if (!ID.test(String(c.location_id ?? ""))) return "bad location id";
  if (!Array.isArray(c.lines) || c.lines.length < 1 || c.lines.length > 200) return "a count holds 1 to 200 lines";
  for (const l of c.lines) {
    if (!ID.test(String(l?.catalog_object_id ?? ""))) return "bad item id";
    if (typeof l.quantity !== "number" || !Number.isFinite(l.quantity) || l.quantity < 0 || l.quantity > 100000) return "bad quantity";
    if (!QTY_TEXT.test(qtyText(l.quantity))) return "bad quantity";
  }
  return undefined;
}
