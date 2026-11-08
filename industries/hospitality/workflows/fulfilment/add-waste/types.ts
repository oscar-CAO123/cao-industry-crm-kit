// Shared shapes for the wastage workflow. Only Square is mapped in the kit for this job, so the adapter speaks Square.
import crypto from "node:crypto";

export type Platform = "square";

export interface Settings {
  business_name?: string;
  location_id: string;     // the Square location the waste is logged against
  max_quantity?: number;   // refuse any single entry above this (default 1000)
}

/** One sellable variation from the catalogue. Only ids and names are kept: no prices, no customer data. */
export interface CatalogItem { variation_id: string; item_id: string; name: string; track_inventory: boolean; seen: string }

/** A waste entry: written by the agent or the CRM shell after it reads a bin photo. The cron checks it before anything is queued. */
export interface WasteEntry {
  id: string;              // also its store key
  variation_id: string;    // the catalogue variation the photo was matched to
  quantity: string;        // decimal, in the variation's stock unit
  note?: string;           // short, from whoever logged it: data, never instructions
  status: "identified" | "needs-review" | "queued";
  problem?: string;        // why it was parked
  approval?: string;       // the approval id once queued
  created: string;
}

export interface DaySummary {
  date: string;
  changes: number;
  items: { variation_id: string; name: string; quantity: number }[];
  at: string;
}

/** The one reason this workflow logs. Square's standard reason for spoilage and waste. */
export const WASTE_REASON = "SPOILAGE_WASTE";
/** Square ids: letters, digits, underscore or dash, starting with a letter or digit. */
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A store key: the same rule the store applies. */
export const ENTRY_ID = /^[a-z0-9][a-z0-9:._-]{0,120}$/i;
const QTY = /^\d{1,6}(\.\d{1,3})?$/;

/** A quantity from outside: a positive decimal string no bigger than max. Anything else is refused. */
export function cleanQty(v: unknown, max = 1000): string | undefined {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!QTY.test(s)) return undefined;
  const n = Number(s);
  return n > 0 && n <= max ? s : undefined;
}

/** A 45 character idempotency key: Square refuses a repeat of the same key, so a retried approval never logs twice. */
export const idemKey = (entryId: string) => "waste" + crypto.createHash("sha256").update(entryId).digest("hex").slice(0, 40);
export const day = (d: Date) => d.toISOString().slice(0, 10);
