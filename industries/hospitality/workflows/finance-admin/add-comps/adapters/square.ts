// Square: a venue's paid sales and the discounts on each sale. Both calls are GET reads, so both sit on the draft list.
// Field names come from Square's official API specification: ListPaymentsResponse (payments, cursor), Payment (id,
// order_id, location_id, created_at, status, team_member_id), RetrieveOrderResponse (order), Order (created_at,
// discounts) and OrderLineItemDiscount (name, percentage, applied_money, scope). Money is in cents.
import { LOC, ORDER_ID, cut, type CompCtx } from "../types.ts";

const P = "square";

export interface PaymentRow { id?: string; order_id?: string; created_at: string; status: string; team_member_id?: string }
export interface OrderDiscount { name?: string; percentage?: string; applied_money?: { amount?: number }; scope?: string }
export interface Order { id: string; created_at: string; location_id?: string; discounts?: OrderDiscount[] }

/** One page of a venue's payments in a time window, oldest first. */
export async function payments(ctx: CompCtx, location: string, begin: string, end: string, cursor?: string) {
  if (!LOC.test(location)) throw new Error("square: bad location id");
  const r = await ctx.draft<any>({ platform: P, op: "api.ListPayments", summary: `payments at ${location} from ${begin}`,
    input: { params: { location_id: location, begin_time: begin, end_time: end, sort_order: "ASC", limit: 100, ...(cursor ? { cursor } : {}) } } });
  const rows: PaymentRow[] = Array.isArray(r.data?.payments) ? r.data.payments : [];
  return { rows, cursor: typeof r.data?.cursor === "string" && r.data.cursor ? r.data.cursor : undefined };
}

/** One sale, read whole: its discounts sit on the order record. */
export async function order(ctx: CompCtx, orderId: string): Promise<Order> {
  if (!ORDER_ID.test(orderId)) throw new Error("square: bad order id");
  const r = await ctx.draft<any>({ platform: P, op: "api.RetrieveOrder", summary: `order ${cut(orderId, 40)}`, input: { params: { order_id: orderId } } });
  const o = r.data?.order;
  if (!o || typeof o.id !== "string") throw new Error("square: no order in the reply");
  return o as Order;
}
