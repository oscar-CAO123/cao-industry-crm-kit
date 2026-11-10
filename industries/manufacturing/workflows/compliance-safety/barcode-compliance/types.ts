// Shared shapes for the barcode compliance workflow. Every check is a pure function over what the platform holds.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "unleashed";

export interface Settings {
  business_name?: string;
}

/** A product as the adapter reads it. `raw` is the record as the platform returned it, kept for the update body. */
export interface Product {
  guid: string;
  code: string;
  description: string;
  barcode: string;
  obsolete: boolean;
  raw: Record<string, unknown>;
}

/** The latest check of one product. Written by the check cron; a re-run replaces it. */
export interface Finding {
  guid: string;
  code: string;
  barcode: string;
  problems: string[];
  status: "ok" | "flagged";
  checked: string;
}

/** A corrected GTIN the business has supplied for one product. Written to the store, never by a cron. */
export interface Fix {
  product: string;      // the product guid on the platform
  barcode: string;      // the corrected GTIN, digits only
  approval?: string;    // set once the update is queued, so a re-run never reads or queues it again
  error?: string;       // why the last attempt failed (for example the product could not be read); cleared on success
}

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (s: unknown): s is string => typeof s === "string" && GUID.test(s);
export const keyOf = (s: string) => safeKey(s, 90);

/** GS1 identification keys are 8, 12, 13 or 14 digits, the last one a check digit (mod 10, weights 3 and 1 from the right). */
export function gtinProblems(raw: string): string[] {
  const s = String(raw ?? "").trim();
  if (!s) return ["no barcode"];
  if (!/^\d+$/.test(s)) return ["not digits only"];
  if (![8, 12, 13, 14].includes(s.length)) return [`${s.length} digits: GS1 keys are 8, 12, 13 or 14 digits`];
  const data = s.slice(0, -1).split("").map(Number);
  let sum = 0;
  for (let i = data.length - 1, k = 0; i >= 0; i--, k++) sum += data[i] * (k % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(s.at(-1)) ? [] : ["check digit is wrong"];
}

/** Two products sharing a GTIN, compared at 14 digits so a zero-padded 12-digit UPC matches its 13 or 14 digit form. */
export const gtin14 = (s: string) => String(s ?? "").trim().padStart(14, "0");


/** The product fields a barcode send is checked against. The update rewrites the whole product as read, so these are the
 *  fields a change in Unleashed would most likely be overwritten through. Limited to 10 by the runtime's check. */
export const CHECKED_FIELDS = ["Barcode", "ProductCode", "ProductDescription", "Obsolete", "IsSellable", "Notes", "Comments", "BinLocation", "DefaultSellPrice", "DefaultPurchasePrice"];
/** The values the cron read for those fields, as a check expects them. Only scalars can be compared; a missing Barcode is read as null. */
export function seenValues(raw: Record<string, unknown>): { path: string; equals: string | number | boolean | null }[] {
  return CHECKED_FIELDS.flatMap((path) => {
    const v = path === "Barcode" ? (raw[path] ?? null) : raw[path];
    return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? [{ path, equals: v }] : [];
  });
}
