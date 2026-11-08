// Unleashed: the sales orders a business fulfils from. Reads sales orders and stock on hand, and builds the sales
// shipment that the dispatch cron queues for approval. Field names come from the vendor spec
// (endpoint-map/raw/unleashed/pages: SalesOrders, StockOnHand, SalesShipments). Every list reply is { Pagination, Items }.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Order, type OrderLine, type Settings, type Stock, GUID, ORDER_NO, SKU, day, units } from "../types.ts";

const P = "unleashed";
type Row = Record<string, any>;

/** The first page (200) of sales orders in the settings' status. Later pages need a paged path the ops file does not map. */
export async function salesOrders(ctx: Ctx<Settings>): Promise<Row[]> {
  const u = ctx.settings.unleashed;
  const r = await ctx.draft<{ Items?: Row[] }>({ platform: P, op: "docs.get_SalesOrders", summary: `read ${u.order_status} sales orders`,
    input: { params: { orderStatus: u.order_status, pageSize: 200 } } });
  return r.data?.Items ?? [];
}

/** Stock on hand in the settings' warehouse, summed by SKU. */
export async function stockOnHand(ctx: Ctx<Settings>): Promise<Stock[]> {
  const w = ctx.settings.unleashed.warehouse_code;
  const r = await ctx.draft<{ Items?: Row[] }>({ platform: P, op: "docs.get_StockOnHand", summary: `read stock in ${w}` });
  const by = new Map<string, number>();
  for (const i of r.data?.Items ?? []) {
    const sku = String(i.ProductCode ?? "");
    if (i.Warehouse?.WarehouseCode !== w || !SKU.test(sku)) continue;
    by.set(sku, (by.get(sku) ?? 0) + (Number(i.AvailableQty) || 0));
  }
  return [...by].map(([sku, available]) => ({ sku, available }));
}

/** A sales order row as a stored order, or null when its number, Guid or lines fail validation. */
export function toOrder(row: Row, now: Date): Order | null {
  const number = String(row.OrderNumber ?? ""), guid = String(row.Guid ?? "");
  if (!ORDER_NO.test(number) || !GUID.test(guid)) return null;
  const lines: OrderLine[] = [];
  for (const l of row.SalesOrderLines ?? []) {
    const sku = String(l.ProductCode ?? ""), qty = Number(l.OrderQuantity), line = Number(l.LineNumber);
    if (!SKU.test(sku) || !Number.isInteger(qty) || qty < 1 || qty > 100000 || !Number.isInteger(line)) return null;
    lines.push({ line, sku, qty });
  }
  if (!lines.length) return null;
  return { key: `ord-${number}`, number, guid, customer: String(row.CustomerName ?? "").slice(0, 200), lines, status: "new", seen: now.toISOString() };
}

/** The sales shipment body for one order, as the SalesShipments POST takes it. */
export function shipmentBody(ctx: Ctx<Settings>, o: Order) {
  return {
    OrderNumber: o.number,
    OrderGuid: o.guid,
    DispatchDate: day(ctx.now),
    Warehouse: { WarehouseCode: ctx.settings.unleashed.warehouse_code },
    SalesShipmentLines: o.lines.map((l) => ({ SalesOrderLineNumber: l.line, Product: { ProductCode: l.sku }, ShipmentQty: l.qty })),
  };
}

/** What the approver sees for a shipment. The customer's name is data, shown as text only. */
export const dispatchSummary = (o: Order) =>
  `Dispatch ${o.number} for ${o.customer || "customer"}: ${o.lines.length} lines, ${units(o)} units. Check Unleashed has no shipment for it yet.`;
