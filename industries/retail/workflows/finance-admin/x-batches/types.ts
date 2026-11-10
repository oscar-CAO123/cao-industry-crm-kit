// Shared shapes for the batches and landed costs workflow. Cin7 is the only platform here with mapped operations
// and a sign-in the kit can call; the others are listed in workflow.json gaps.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";

export type Platform = "cin7";

export interface Settings {
  business_name?: string;
  /** Cin7 branch (location) to read and adjust. Omit to use every branch. */
  cin7?: { branch_id?: number; rows?: number };
  /** Written on every queued stock adjustment, so the approver and the audit trail see why it was made. */
  adjustment_reason: string;
}

/** One received purchase-order line, with the PO's cost pool (freight, surcharge) for the owner to spread. */
export interface ReceiptLine {
  key: string;
  po_id: number;
  po_reference?: string;
  line_id: number;
  product_id: number;
  code: string;
  name: string;
  barcode?: string;
  qty: number;
  po_product_total: number;
  po_freight_total: number;
  po_surcharge: number;
  received_date: string;
  recorded: string;
}

/** A serial or batch number on a received line. */
export interface SerialRecord {
  key: string;
  serial: string;
  serial_id: number;
  line_id: number;
  product_id: number;
  code: string;
  recorded: string;
}

/** A stock change a person proposed (written into the store by the agent or the CRM shell). Nothing moves until approved. */
export interface Proposal {
  key: string;
  barcode: string;
  qty_adjusted: number;
  reason?: string;
  status: "proposed" | "queued" | "adjusted" | "rejected";
  queued_approval?: string;
  reject_reason?: string;
  ref?: Record<string, string>;
}

export interface StockSnapshot {
  key: string;
  barcode: string;
  product_id: number;
  on_hand: number;
  available: number;
  open_sales: number;
  incoming: number;
  holding: number;
  recorded: string;
}
