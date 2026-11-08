// Unleashed: the purchase order that lives in the ERP. Reads stock, products and orders. A draft is a Parked order,
// which is internal; moving an order to Placed sends it to the supplier, so that is a live operation a person approves.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

const P = "unleashed";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id from Unleashed goes into a path only after this check. */
export const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("unleashed: bad id"); return s; };

export const unleashed = {
  async stock(ctx: Ctx<Settings>): Promise<any[]> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_StockOnHand", summary: "stock on hand" });
    return r.data?.Items ?? [];
  },
  async products(ctx: Ctx<Settings>): Promise<any[]> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_Products", summary: "products and suppliers" });
    return r.data?.Items ?? [];
  },
  async orders(ctx: Ctx<Settings>): Promise<any[]> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_PurchaseOrders", summary: "purchase orders" });
    return r.data?.Items ?? [];
  },
  /** Draft a purchase order in Parked status. Parked is internal until someone places it. */
  async draftOrder(ctx: Ctx<Settings>, body: Record<string, unknown>, summary: string): Promise<{ guid: string; number: string }> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.post_PurchaseOrders", summary, input: { body } });
    return { guid: guid(r.data?.Guid), number: String(r.data?.OrderNumber ?? "") };
  },
  /** The live call that places an order. Only ever passed to ctx.queue. The body is the whole order with OrderStatus Placed. */
  placeOp(orderGuid: string, body: Record<string, unknown>) {
    return { platform: P, op: "docs.put_PurchaseOrders_orderGuid", input: { params: { orderGuid: guid(orderGuid) }, body } };
  },
};
