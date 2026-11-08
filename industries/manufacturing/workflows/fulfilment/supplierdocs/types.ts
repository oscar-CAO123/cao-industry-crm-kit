// Shared shapes for the supplier documents workflow. The one adapter (Xero) speaks these.

export interface Settings {
  business_name?: string;
  /** How far a billed unit price may sit from the Xero item's purchase price before a person reviews it. */
  price_tolerance_percent?: number;
}

export interface DocLine {
  description: string;
  code: string;          // the supplier's or Xero's item code as billed (may be empty)
  qty: number;
  unit: number;          // billed unit price, ex tax
  sku?: string;          // matched Xero item code
  cost?: number;         // that item's purchase price in Xero
}

export interface Doc {
  id: string;            // Xero InvoiceID
  number: string;        // bill number
  supplier: string;
  date: string;
  total: number;
  lines: DocLine[];
  status: "new" | "matched" | "needs-review" | "queued" | "authorised" | "rejected";
  reasons: string[];
  seen: string;
  approval?: string;
}

export interface Item { code: string; name: string; cost: number }

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
export const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);
export const num = (v: unknown, max = 1e9) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0; };
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
