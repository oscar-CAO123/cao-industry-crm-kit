// Cin7 Omni: the order book, stock and purchase orders. Reads are draft operations. A purchase order goes to a
// supplier, so it is only ever queued for a person to approve. Field names come from the vendor's OpenAPI spec
// not from guesses.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Order, type OrderLine, type Reorder, type Settings, SAFE_CODE, EMAIL, num, text, ms } from "../types.ts";

const P = "cin7";
const PAGES = 10, ROWS = 50;

/** One Cin7 sales order to the order book. Lines with a code we cannot filter on are left out and the order says so. */
function toOrder(so: any): Order | null {
  const id = Number(so?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const raw = (Array.isArray(so.lineItems) ? so.lineItems : []).slice(0, 200);
  const lines: OrderLine[] = raw
    .map((l: any) => ({ code: text(l?.code, 64), name: text(l?.name || l?.code, 200), qty: num(l?.qty), qtyShipped: num(l?.qtyShipped), unitPrice: num(l?.unitPrice) }))
    .filter((l: OrderLine) => SAFE_CODE.test(l.code) && l.qty > 0);
  const dropped = raw.length - lines.length;
  const email = text(so.email, 190);
  return {
    key: `so-${id}`, id, reference: text(so.reference, 100),
    customer: text(so.company || [so.firstName, so.lastName].filter(Boolean).join(" "), 200),
    email: EMAIL.test(email) ? email : undefined,
    lines,
    status: so.isVoid ? "void" : so.dispatchedDate ? "shipped" : "open",
    modified: text(so.modifiedDate, 40),
    error: dropped ? `${dropped} line(s) with a code this workflow cannot use were left out` : undefined,
  };
}

/** Sales orders changed since `since`, newest first, up to PAGES pages. Stops at the first order already seen. */
export async function recentOrders(ctx: Ctx<Settings>, since: string): Promise<Order[]> {
  const out: Order[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const r = await ctx.draft<unknown>({ platform: P, op: "get /api/v1/SalesOrders", summary: `sales orders page ${page}`,
      input: { params: { order: "modifiedDate DESC", rows: ROWS, page } } });
    const rows = Array.isArray(r.data) ? r.data : [];
    let done = rows.length < ROWS;
    for (const so of rows) {
      const o = toOrder(so);
      if (!o) continue;
      const seen = ms(o.modified), mark = ms(since);
      if (Number.isFinite(seen) && Number.isFinite(mark) && seen <= mark) { done = true; continue; }
      out.push(o);
    }
    if (done) break;
  }
  return out;
}

/** Cin7's own available count for one product code, summed over its locations. */
export async function stockAvailable(ctx: Ctx<Settings>, code: string): Promise<number> {
  if (!SAFE_CODE.test(code)) throw new Error("cin7: bad product code");
  const r = await ctx.draft<unknown>({ platform: P, op: "get /api/v1/Stock", summary: `stock for ${code}`,
    input: { params: { where: `code='${code}'`, rows: ROWS } } });
  const rows = Array.isArray(r.data) ? r.data : [];
  return rows.filter((s: any) => s?.code === code).reduce((a: number, s: any) => a + num(s.available), 0);
}

/** Recent purchase orders, for matching supplier bills. */
export async function purchaseOrders(ctx: Ctx<Settings>): Promise<any[]> {
  const r = await ctx.draft<unknown>({ platform: P, op: "get /api/v1/PurchaseOrders", summary: "recent purchase orders",
    input: { params: { order: "modifiedDate DESC", rows: 250, page: 1 } } });
  return Array.isArray(r.data) ? r.data : [];
}

/** Queue one purchase order to a supplier for approval. The key is per product per day, so a re-run never queues it twice. */
export function queuePurchaseOrder(ctx: Ctx<Settings>, rule: Reorder, today: string, need: number, avail: number): Promise<string> {
  const body = [{
    reference: `AUTO-${rule.code}-${today}`.slice(0, 100),
    memberId: rule.supplier_member_id,
    company: text(rule.supplier_name, 200),
    lineItems: [{ code: rule.code, name: text(rule.name ?? rule.code, 200), qty: rule.order_qty, unitPrice: rule.unit_price }],
  }];
  return ctx.queue({ platform: P, op: "post /api/v1/PurchaseOrders", key: `po-${rule.code}-${today}`,
    summary: `purchase order ${rule.order_qty} x ${rule.code} from ${rule.supplier_name}`, input: { body } },
    `Raise purchase order to ${text(rule.supplier_name, 80)}: ${rule.order_qty} x ${rule.code} (open orders need ${need}, Cin7 shows ${avail} available)`);
}
