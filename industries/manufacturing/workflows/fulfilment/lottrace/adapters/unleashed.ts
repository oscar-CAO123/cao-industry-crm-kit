// Unleashed: batch, serial, stock and count records. Reads are draft operations. A warehouse transfer is a live operation and is only queued.
// Calls go through the SDK, which signs each Unleashed request with the sign-in keys from the environment (core/sdk/call.ts, provider "unleashed").
// Field names come from the vendor's docs pages.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Lot, type Serial, type Position, type AuditEntry, type Hold, PRODUCT, text, num, guidOf, warehouseOf } from "../types.ts";

const P = "unleashed";
const items = (r: { data?: any }): any[] => (Array.isArray(r?.data?.Items) ? r.data.Items : []);
/** Unleashed JSON dates are /Date(ms)/ strings. */
export const unleashedDate = (d: Date) => `/Date(${d.getTime()})/`;

export async function batches(ctx: Ctx<Settings>): Promise<Lot[]> {
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_BatchNumbers", summary: "read batch numbers", input: { params: { available: "true", pageSize: 200 } } });
  return items(r).flatMap((b: any): Lot[] => {
    const guid = guidOf(b.Guid), product = String(b.ProductCode ?? "");
    if (!guid || !PRODUCT.test(product)) return [];
    return [{ guid, batch: text(b.BatchNumber, 50), product, qty: num(b.Quantity), warehouse: warehouseOf(b.WarehouseCode), expiry: text(b.ExpiryDate, 30), status: text(b.Status, 20) }];
  });
}

export async function serials(ctx: Ctx<Settings>): Promise<Serial[]> {
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_SerialNumbers", summary: "read serial numbers", input: { params: { available: "true", pageSize: 200 } } });
  return items(r).flatMap((s: any): Serial[] => {
    const guid = guidOf(s.Guid), product = String(s.ProductCode ?? "");
    if (!guid || !PRODUCT.test(product)) return [];
    return [{ guid, serial: text(s.SerialNumber, 50), product, warehouse: warehouseOf(s.WarehouseCode), status: text(s.Status, 20) }];
  });
}

export async function positions(ctx: Ctx<Settings>): Promise<Position[]> {
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_StockOnHand", summary: "read stock on hand" });
  return items(r).flatMap((p: any): Position[] => {
    const guid = guidOf(p.Guid), product = String(p.ProductCode ?? "");
    if (!guid || !PRODUCT.test(product)) return [];
    return [{ guid, product, warehouse: warehouseOf(p.WarehouseCode), qty: num(p.QtyOnHand), available: num(p.AvailableQty) }];
  });
}

/** Stock counts and stock adjustments: the internal record an audit reads. */
export async function audits(ctx: Ctx<Settings>): Promise<AuditEntry[]> {
  const counts = await ctx.draft<any>({ platform: P, op: "docs.get_StockCounts", summary: "read stock counts" });
  const adjustments = await ctx.draft<any>({ platform: P, op: "docs.get_StockAdjustments", summary: "read stock adjustments" });
  const out: AuditEntry[] = [];
  for (const c of items(counts)) {
    const guid = guidOf(c.Guid);
    if (guid) out.push({ guid, kind: "count", ref: text(c.StockTakeName, 100), date: text(c.CountDate, 30), status: text(c.Status, 20), warehouse: warehouseOf(c.Warehouse?.WarehouseCode), reason: text(c.CountType, 10) });
  }
  for (const a of items(adjustments)) {
    const guid = guidOf(a.Guid);
    if (guid) out.push({ guid, kind: "adjustment", ref: text(a.AdjustmentNumber, 20), date: text(a.AdjustmentDate, 30), status: text(a.Status, 20), warehouse: warehouseOf(a.Warehouse?.WarehouseCode), reason: text(a.AdjustmentReason, 20) });
  }
  return out;
}

/** The live act that moves held stock to the quarantine warehouse. The cron queues it; a person approves it. */
export function holdTransfer(ctx: Ctx<Settings>, h: Hold) {
  const to = ctx.settings.quarantine_warehouse;
  return {
    platform: P, op: "docs.post_WarehouseStockTransfers", key: `hold:${h.guid}`,
    summary: `Move ${h.qty} of ${h.product} (batch ${h.batch}) from ${h.from} to ${to} in Unleashed`,
    input: { body: {
      OrderDate: unleashedDate(ctx.now), Comments: text(`Quarantine hold: ${h.reason}`, 1000),
      SourceWarehouse: { WarehouseCode: h.from }, DestinationWarehouse: { WarehouseCode: to },
      TransferDetails: [{ LineNumber: 1, Product: { ProductCode: h.product }, TransferQuantity: h.qty }],
    } },
  };
}
