// Cin7 Omni: purchase-order receipts, serial and batch numbers, stock on hand, and stock adjustments.
// Field names come from the vendor's swagger (endpoint-map/raw/cin7/spec). Reads run as drafts; the one write,
// a stock adjustment, is only ever queued for a person to approve.
import type { Ctx } from "../../../../../../../core/workflows/runtime.ts";
import type { ReceiptLine, Settings, SerialRecord, StockSnapshot, Proposal } from "../types.ts";

const P = "cin7";
const MAX_PO = 50;      // purchase orders read per run
const MAX_STOCK = 50;   // stock reads per run
const MAX_QTY = 100000;

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("cin7: bad id");
  return n;
};
const BARCODE = /^[A-Za-z0-9._-]{1,64}$/;
const barcode = (v: unknown): string => {
  const s = String(v ?? "");
  if (!BARCODE.test(s)) throw new Error("cin7: bad barcode");
  return s;
};
const rows = (ctx: Ctx<Settings>) => Math.min(Math.max(1, Math.trunc(ctx.settings.cin7?.rows ?? 50)), 250);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const inBranch = (ctx: Ctx<Settings>, u: any) => !ctx.settings.cin7?.branch_id || Number(u?.branchId) === ctx.settings.cin7.branch_id;

/** Received lines: purchase orders Cin7 marks fully received, with their cost pool. */
export async function receivedLines(ctx: Ctx<Settings>): Promise<ReceiptLine[]> {
  const list = await ctx.draft<any[]>({ platform: P, op: "get /api/v1/PurchaseOrders", summary: "list purchase orders",
    input: { params: { order: "modifiedDate DESC", rows: rows(ctx) } } });
  const out: ReceiptLine[] = [];
  const done = (list.data ?? []).filter((po: any) => po?.fullyReceivedDate && !po.isVoid).slice(0, MAX_PO);
  for (const po of done) {
    const poId = id(po.id);
    const full = await ctx.draft<any>({ platform: P, op: "get /api/v1/PurchaseOrders/{id}", summary: `purchase order ${poId}`,
      input: { params: { id: poId } } });
    const d = full.data ?? po;
    for (const li of d.lineItems ?? []) {
      out.push({
        key: `po${poId}-l${id(li.id)}`, po_id: poId, po_reference: String(d.reference ?? "").slice(0, 100) || undefined,
        line_id: id(li.id), product_id: id(li.productId), code: String(li.code ?? "").slice(0, 100), name: String(li.name ?? "").slice(0, 200),
        barcode: li.barcode ? barcode(li.barcode) : undefined, qty: num(li.qty),
        po_product_total: num(d.productTotal), po_freight_total: num(d.freightTotal), po_surcharge: num(d.surcharge),
        received_date: String(d.fullyReceivedDate ?? "").slice(0, 30), recorded: ctx.now.toISOString(),
      });
    }
  }
  return out;
}

/** Serial or batch numbers attached to the received lines. Matches on lineItemId, so only receipts we hold are kept. */
export async function serialRecords(ctx: Ctx<Settings>, lineIds: Set<number>): Promise<SerialRecord[]> {
  const r = await ctx.draft<any[]>({ platform: P, op: "get /api/v1/SerialNumbers", summary: "list serial numbers",
    input: { params: { order: "id DESC", rows: rows(ctx) } } });
  const out: SerialRecord[] = [];
  for (const s of r.data ?? []) {
    if (!lineIds.has(Number(s?.lineItemId))) continue;
    out.push({ key: `serial${id(s.id)}`, serial: String(s.serialnumber ?? "").slice(0, 120), serial_id: id(s.id),
      line_id: id(s.lineItemId), product_id: id(s.productId), code: String(s.code ?? "").slice(0, 100), recorded: ctx.now.toISOString() });
  }
  return out;
}

/** Stock on hand for one barcode, in the configured branch. Barcodes are checked before they reach the path. */
export async function stockFor(ctx: Ctx<Settings>, bc: string): Promise<any[]> {
  const r = await ctx.draft<any>({ platform: P, op: "get /api/v1/Stock/{barcode}", summary: `stock for ${bc}`,
    input: { params: { barcode: barcode(bc) } } });
  const units = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
  return units.filter((u) => inBranch(ctx, u));
}

export function snapshot(ctx: Ctx<Settings>, rc: ReceiptLine, unit: any): StockSnapshot {
  return { key: rc.key, barcode: rc.barcode ?? "", product_id: id(unit.productId), on_hand: num(unit.stockOnHand),
    available: num(unit.available), open_sales: num(unit.openSales), incoming: num(unit.incoming), holding: num(unit.holding),
    recorded: ctx.now.toISOString() };
}

/** Queue a stock adjustment for approval. Cin7 is changed only when a person approves it. */
export async function queueAdjustment(ctx: Ctx<Settings>, p: Proposal, unit: any): Promise<string> {
  const qty = Number(p.qty_adjusted);
  if (!Number.isFinite(qty) || qty === 0 || Math.abs(qty) > MAX_QTY) throw new Error("cin7: bad adjustment quantity");
  const body = [{
    reference: p.key.slice(0, 50), branchId: unit.branchId, adjustmentReason: ctx.settings.adjustment_reason.slice(0, 200),
    lineItems: [{ productId: id(unit.productId), ...(unit.productOptionId ? { productOptionId: id(unit.productOptionId) } : {}),
      code: String(unit.code ?? "").slice(0, 100), name: String(unit.productName ?? "").slice(0, 200), qtyAdjusted: qty }],
  }];
  const summary = `Adjust ${unit.code ?? p.barcode} by ${qty} in Cin7${p.reason ? ` (${p.reason.slice(0, 120)})` : ""}`;
  return ctx.queue({ platform: P, op: "post /api/v1/Adjustments", summary, key: `adjust:${p.key}`, input: { body } }, summary);
}
