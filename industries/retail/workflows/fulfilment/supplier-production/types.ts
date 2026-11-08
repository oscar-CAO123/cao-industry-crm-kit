// Shared shapes for the supplier production workflow. Monday holds each order on the production board; Xero holds the
// factory contact, the purchase order, the deposit bill and the payment. Every cron reads or drafts. Authorising a
// purchase order or a bill, and paying, wait for a person in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface Settings {
  family: string;
  business_name?: string;
  production: "monday";          // the board: one item per order, with its factory and delivery date
  suppliers: "xero";             // factory contacts, purchase orders, deposit bills and payments
  rate_card: "xero";             // unit costs from the Xero items list (purchase price)
  monday: {
    board_id: string;
    columns: { status: string; factory: string; delivery: string };
    labels: { new: string; po_drafted: string; at_risk: string; shipped: string };
  };
  xero?: { deposit_percent?: number; bank_account_code?: string; purchase_account_code?: string };
  delivery_warn_days?: number;
}

export interface Job {
  id: string;                    // the Monday item id
  name: string;
  factory: string;
  delivery?: string;             // YYYY-MM-DD, the retailer's delivery date
  received: string;
  status: "new" | "needs-lines" | "po-drafted" | "at-risk" | "shipped";
  reason?: string;
  po?: { id: string; number?: string; contact_id: string; total_ex_gst: number };
  po_status?: string;
  bill_id?: string;
}

export interface Line { code: string; name: string; qty: number; unitCost: number; ref?: Record<string, string> }
export interface RateItem { code: string; name: string; price: number; ref?: Record<string, string> }
export interface MondayItem { id: string; name: string; status: string; factory: string; delivery: string }

export const ITEM_ID = /^\d{1,20}$/;
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const BANK = /^[A-Za-z0-9]{1,10}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
export const keyOf = (s: string) => safeKey(s, 90);
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const total = (lines: { qty: number; unitCost: number }[]) => Math.round(lines.reduce((a, l) => a + l.qty * l.unitCost, 0) * 100) / 100;
export const day = (d: Date) => d.toISOString().slice(0, 10);
