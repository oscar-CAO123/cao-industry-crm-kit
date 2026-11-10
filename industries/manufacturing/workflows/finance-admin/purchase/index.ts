// The manufacturing purchase workflow's three crons. Each is deterministic: it reads and drafts, or queues for a person.
// Judgment (a hand request, matching a supplier's invoice) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { BillLine, Order, Settings } from "./types.ts";
import { day, money } from "./types.ts";
import { unleashed } from "./adapters/unleashed.ts";
import { xero } from "./adapters/xero.ts";

const DAY = 864e5;
/** A product with an order in one of these states already has one in hand, or one a person must check: do not raise another. */
const OPEN = new Set(["pending", "parked", "placed", "received", "failed"]);

/** Hourly: stock under its minimum with no open order becomes a Parked purchase order in Unleashed. */
export async function reorder(ctx: Ctx<Settings>) {
  const levels = ctx.settings.reorder_levels ?? [];
  if (!levels.length) { ctx.log("reorder: no reorder_levels in settings"); return { drafted: 0, skipped: 0 }; }
  const taxPct = ctx.settings.tax_rate_percent;
  if (typeof taxPct !== "number" || !(taxPct >= 0 && taxPct <= 100)) { ctx.log("reorder: tax_rate_percent is missing or not 0 to 100, so no order is totalled"); return { drafted: 0, skipped: 0 }; }
  const stock = await unleashed.stock(ctx);
  const products = new Map((await unleashed.products(ctx)).map((p: any) => [String(p.ProductCode), p]));
  const orders = await ctx.store.list<Order>("orders");
  let drafted = 0, skipped = 0;
  for (const lvl of levels) {
    const code = String(lvl.productCode);
    const have = Number(stock.find((s: any) => s.ProductCode === code)?.AvailableQty ?? 0);
    if (!(have < Number(lvl.minQty))) continue;
    const prior = orders[code];
    if (prior && OPEN.has(prior.status)) { skipped++; continue; }
    const p = products.get(code);
    const price = Number(p?.DefaultPurchasePrice), qty = Number(lvl.orderQty);
    if (!p?.SupplierCode || !(price >= 0) || !(qty > 0)) { ctx.log(`reorder: ${code} needs a supplier, a price and an order quantity`); skipped++; continue; }
    const supplier = String(p.SupplierCode), supplierName = String(p.SupplierName ?? supplier);
    // Written before the call: if the reply is lost, the next run waits for a person's check instead of raising a second order.
    await ctx.store.put("orders", code, { product_code: code, status: "pending", created: ctx.now.toISOString(),
      supplier_code: supplier, supplier_name: supplierName } satisfies Order);
    // Unleashed requires SubTotal, TaxTotal and Total on the order, so they are worked out from the line here.
    const subTotal = Math.round(qty * price * 100) / 100;
    const taxTotal = Math.round(subTotal * taxPct) / 100;
    const total = Math.round((subTotal + taxTotal) * 100) / 100;
    const body = {
      Supplier: { SupplierCode: supplier }, Warehouse: { WarehouseCode: ctx.settings.warehouse_code }, OrderStatus: "Parked",
      DeliveryDate: day(new Date(ctx.now.getTime() + (ctx.settings.delivery_days ?? 14) * DAY)),
      Comments: `Reorder: stock ${have} under minimum ${lvl.minQty}`,
      PurchaseOrderLines: [{ LineNumber: 1, Product: { ProductCode: code }, OrderQuantity: qty, UnitPrice: price }],
      SubTotal: subTotal, TaxTotal: taxTotal, Total: total,
    };
    let made: { guid: string; number: string };
    try { made = await unleashed.draftOrder(ctx, body, `draft PO for ${code} from ${supplierName}`); }
    catch (e: any) {
      // The order may or may not exist in Unleashed, so the row is "failed": it blocks a second order until a person checks and clears it.
      await ctx.store.put("orders", code, { product_code: code, status: "failed", created: ctx.now.toISOString(),
        supplier_code: supplier, supplier_name: supplierName, body, error: String(e?.message ?? e).slice(0, 240) } satisfies Order);
      ctx.log(`reorder: ${code} draft failed, a person checks Unleashed and clears the row`);
      skipped++;
      continue;
    }
    await ctx.store.put("orders", code, { product_code: code, status: "parked", created: ctx.now.toISOString(),
      supplier_code: supplier, supplier_name: supplierName, guid: made.guid, number: made.number, body,
      total_ex_gst: subTotal } satisfies Order);
    drafted++;
  }
  ctx.log(`reorder: ${drafted} drafted, ${skipped} skipped`);
  return { drafted, skipped };
}

/** Hourly: each parked order is queued for a person to place with the supplier. The cron never places one itself. */
export async function place(ctx: Ctx<Settings>) {
  let queued = 0;
  for (const o of Object.values(await ctx.store.list<Order>("orders"))) {
    if (o.status !== "parked" || !o.guid || !o.body) continue;
    const act = unleashed.placeOp(o.guid, { ...o.body, Guid: o.guid, OrderStatus: "Placed" });
    const lines = (o.body.PurchaseOrderLines as unknown[] | undefined)?.length ?? 0;
    await ctx.queue({ ...act, summary: `place PO ${o.number} with ${o.supplier_name}`, key: `place:${o.guid}` },
      `Place PO ${o.number} with ${o.supplier_name}: ${lines} line(s), ${money(o.total_ex_gst ?? 0)} ex GST`);
    queued++;
  }
  ctx.log(`place: ${queued} queued for approval`);
  return { queued };
}

/** Every two hours: sync order status from Unleashed, then draft the supplier bill in Xero for each receipted order. */
export async function bill(ctx: Ctx<Settings>) {
  const byGuid = new Map((await unleashed.orders(ctx)).map((p: any) => [String(p.Guid), p]));
  let billed = 0;
  for (const o of Object.values(await ctx.store.list<Order>("orders"))) {
    const po: any = o.guid ? byGuid.get(o.guid) : undefined;
    if (!po || o.status === "billed" || o.status === "pending") continue;
    const st = String(po.OrderStatus ?? "");
    const next = st === "Receipted" || st === "Complete" ? "received" : st === "Placed" && o.status === "parked" ? "placed" : o.status;
    if (next !== o.status) { o.status = next; await ctx.store.put("orders", o.product_code, o); }
    if (next !== "received") continue;
    const lines: BillLine[] = (po.PurchaseOrderLines ?? []).map((l: any) => ({
      Description: `${l.Product?.ProductCode ?? ""} ${l.Product?.ProductDescription ?? ""}`.trim().slice(0, 4000),
      Quantity: Number(l.ReceiptQuantity ?? 0), UnitAmount: Number(l.UnitPrice),
    })).filter((l: BillLine) => l.Quantity > 0 && l.UnitAmount >= 0);
    if (!lines.length) continue;
    const contact = await xero.supplierContact(ctx, o.supplier_name ?? o.supplier_code ?? "Supplier", o.supplier_code ?? "");
    o.bill_id = await xero.draftBill(ctx, o.product_code, contact, o.number ?? o.guid ?? "", lines);
    o.status = "billed";
    await ctx.store.put("orders", o.product_code, o);
    billed++;
  }
  ctx.log(`bill: ${billed} drafted`);
  return { billed };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { reorder, place, bill };
