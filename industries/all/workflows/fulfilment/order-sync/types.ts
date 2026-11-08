// Shared shapes for the order-sync workflow. Cin7 holds the order book, stock and purchase orders; Xero holds the
// customer invoices and the supplier bills. Every value that comes from a platform is data, checked before use.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "cin7" | "xero";

/** One supplier rule: when open orders need more of `code` than Cin7 has available, a purchase order is queued. */
export interface Reorder {
  code: string;
  name?: string;
  supplier_member_id: number;   // the supplier's Cin7 contact id (memberId on a purchase order)
  supplier_name: string;
  unit_price: number;
  order_qty: number;
}

export interface Settings {
  business_name?: string;
  reorder?: Reorder[];
  invoice?: { on_ship: "xero-invoice-draft" | "none"; due_days?: number };
}

export interface OrderLine { code: string; name: string; qty: number; qtyShipped: number; unitPrice: number }
export interface Order {
  key: string;                  // so-<cin7 id>
  id: number;
  reference: string;
  customer: string;
  email?: string;
  lines: OrderLine[];
  status: "open" | "shipped" | "void";
  modified: string;             // Cin7 modifiedDate, as sent
  xero_invoice?: string;        // the Xero draft invoice, once drafted
  error?: string;               // the last failure for this order, so the next run can see it
}

export const SAFE_CODE = /^[A-Za-z0-9._-]{1,64}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };

/** A number from a platform: finite and not negative, or zero. */
export const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
/** Free text from a platform: control characters out, length capped. Never placed in HTML or a filter. */
export const text = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const keyOf = (s: string) => safeKey(s, 90);
/** Milliseconds from a platform date, or NaN when it cannot be read. */
export const ms = (s: unknown) => { const n = Date.parse(String(s ?? "")); return Number.isFinite(n) ? n : NaN; };

/** Settings are trusted, but a rule's code goes into a Cin7 filter, so it is checked before use. */
export function checkReorder(rules: Reorder[]) {
  for (const r of rules) {
    if (!SAFE_CODE.test(r.code)) throw new Error(`order-sync: bad product code in settings: ${r.code.slice(0, 20)}`);
    if (!Number.isSafeInteger(r.supplier_member_id) || r.supplier_member_id <= 0) throw new Error(`order-sync: bad supplier id for ${r.code}`);
    if (!(r.order_qty > 0) || !(r.unit_price >= 0)) throw new Error(`order-sync: bad quantity or price for ${r.code}`);
  }
}
