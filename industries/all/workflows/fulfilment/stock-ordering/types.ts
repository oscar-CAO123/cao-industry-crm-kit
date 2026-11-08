// Shared shapes for the stock-ordering workflow. Xero holds the stock on hand and the purchase orders.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface Rule { code: string; min: number; max: number; supplier: string }
export interface Settings {
  business_name?: string;
  delivery_days?: number;   // expected days from order to delivery, default 14
  rules: Rule[];            // one per item the owner reorders
}
/** Stock on hand for one ruled item, as read from Xero. unit_cost is null when Xero has no purchase price. */
export interface Stock { code: string; item_id: string; name: string; on_hand: number; unit_cost: number | null; checked: string }
export type PoStatus = "DRAFT" | "SUBMITTED" | "AUTHORISED" | "BILLED" | "DELETED";
export const PO_STATUS: PoStatus[] = ["DRAFT", "SUBMITTED", "AUTHORISED", "BILLED", "DELETED"];
/** One reorder: a DRAFT purchase order in Xero, its authorisation waiting for approval, then its delivery. */
export interface Reorder {
  key: string; code: string; qty: number; unit_cost: number; po_id: string;
  stage: "awaiting-approval" | "authorised" | "closed";
  po_status: PoStatus; created: string; expected: string; overdue: boolean; checked?: string;
}

export const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const keyOf = (s: string) => safeKey(s, 90);
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A string from outside the kit, cut to a sane length; anything else becomes empty. */
export const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

/** Checks the owner's rules before any call is made: a bad rule fails here, never at the supplier. */
export function checkRules(s: Settings): Rule[] {
  if (!Array.isArray(s.rules) || !s.rules.length) throw new Error("stock-ordering: settings.rules needs at least one item");
  const seen = new Set<string>();
  return s.rules.map((r, i) => {
    if (!CODE.test(String(r.code))) throw new Error(`stock-ordering: rules[${i}].code is not a Xero item code`);
    if (!GUID.test(String(r.supplier))) throw new Error(`stock-ordering: rules[${i}].supplier must be a Xero contact ID`);
    const min = Number(r.min), max = Number(r.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max <= min || max > 100000)
      throw new Error(`stock-ordering: rules[${i}] needs whole numbers with 0 <= min < max <= 100000`);
    if (seen.has(r.code)) throw new Error(`stock-ordering: rules[${i}].code ${r.code} is listed twice`);
    seen.add(r.code);
    return { code: r.code, min, max, supplier: r.supplier };
  });
}
