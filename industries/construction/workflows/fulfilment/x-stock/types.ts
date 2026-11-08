// Shared shapes for the stock workflow. The crons keep these in the store; the Xero adapter fills them.

export interface Reorder { level: number; order_qty: number; supplier_email: string; supplier_name?: string }

export interface Settings {
  business_name?: string;
  /** Reorder rules keyed by the Xero item code. An item without a rule is never reordered. */
  reorder: Record<string, Reorder>;
}

export interface Request {
  key: string; code: string; name: string; on_hand: number; level: number; qty: number;
  unitPrice: number | null; supplier_email: string; supplier_name?: string;
  status: "new" | "drafted" | "awarded" | "closed" | "skipped";
  reason?: string; po?: { id: string; number?: string }; approval?: string; created: string; updated: string;
}

export interface StockItem { id: string; code: string; name: string; onHand: number; unitPrice: number | null }

export interface BillMatch { invoice: string; total: number; status: "matched" | "differs" | "over" | "no-order"; po?: string; checked: string }

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** A reorder rule the crons may act on: sane numbers and a real supplier address. */
export const validRule = (r: Reorder) =>
  Number.isFinite(r.level) && r.level >= 0 && r.level <= 1e6 &&
  Number.isInteger(r.order_qty) && r.order_qty >= 1 && r.order_qty <= 100000 &&
  EMAIL.test(r.supplier_email ?? "");

/** A request line that may go into a purchase order. */
export const validLine = (r: Request) =>
  r.code.length >= 1 && r.code.length <= 50 &&
  Number.isInteger(r.qty) && r.qty >= 1 && r.qty <= 100000 &&
  r.unitPrice !== null && Number.isFinite(r.unitPrice) && r.unitPrice >= 0 && r.unitPrice <= 1e7;
