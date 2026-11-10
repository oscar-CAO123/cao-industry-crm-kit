// Shared shapes for the manufacturing purchase workflow. Each adapter speaks these.
export type Platform = "unleashed" | "xero";

export interface ReorderLevel { productCode: string; minQty: number; orderQty: number }
export interface Settings {
  warehouse_code: string;            // the Unleashed warehouse orders are raised against
  reorder_levels: ReorderLevel[];    // the business's own minimum stock and order size per product
  delivery_days?: number;            // days from raising to delivery, default 14
  tax_rate_percent: number;          // the purchase tax rate as a percentage (10 for 10%); reorders refuse to run without it
  bill_account_code?: string;        // Xero purchases account code for bill lines, optional
}

export type OrderStatus = "pending" | "parked" | "placed" | "received" | "billed" | "failed";
/** One order per product, keyed by product code in the store. "pending" is written before a call, so a lost reply is checked, not repeated.
 *  "failed" is written when the draft call throws: the order may exist in Unleashed, so a person checks it and clears the row. */
export interface Order {
  product_code: string; status: OrderStatus; created: string;
  supplier_code?: string; supplier_name?: string;
  guid?: string; number?: string; body?: Record<string, unknown>;
  total_ex_gst?: number; bill_id?: string; error?: string;
}
export interface BillLine { Description: string; Quantity: number; UnitAmount: number; AccountCode?: string }

export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const day = (d: Date) => d.toISOString().slice(0, 10);
