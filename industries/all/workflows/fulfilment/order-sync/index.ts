// The order-sync workflow's four crons. Each reads and drafts. The only thing that reaches a supplier is a purchase
// order, and that is queued for a person to approve. Nothing here sends, pays, authorises or changes a status a
// customer sees. Judgment (an order check, a partial shipment, a bill that differs) stays with a person.
import type { Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Order, type Settings, checkReorder, day, ms, num, text } from "./types.ts";
import { recentOrders, stockAvailable, queuePurchaseOrder, purchaseOrders } from "./adapters/cin7.ts";
import { contactFor, draftInvoice, supplierBills } from "./adapters/xero.ts";

/** Every 10 minutes: sales orders changed in Cin7 since the last run go into the order book. */
export async function intake(ctx: Ctx<Settings>) {
  const mark = (await ctx.store.get<{ at: string }>("state", "cin7-watermark"))?.at ?? "";
  const orders = await recentOrders(ctx, mark);
  let top = mark;
  for (const o of orders) {
    const prev = await ctx.store.get<Order>("orders", o.key);
    // A re-read keeps the last invoice error until an invoice is drafted (invoice() clears it).
    await ctx.store.put("orders", o.key, { ...prev, ...o, xero_invoice: prev?.xero_invoice, error: o.error ?? prev?.error });
    if (Number.isFinite(ms(o.modified)) && !(ms(top) >= ms(o.modified))) top = o.modified;
  }
  if (top !== mark) await ctx.store.put("state", "cin7-watermark", { at: top });
  ctx.log(`intake: ${orders.length} sales orders read`);
  return { read: orders.length };
}

const PO_ACT = "post /api/v1/PurchaseOrders";
const REORDER_WINDOW = 14 * 864e5;

/** Codes with a purchase order still pending, running or needing a check, or decided within the reorder window. Read from this workflow's own approvals. */
async function ordersInFlight(ctx: Ctx<Settings>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ap of Object.values(await ctx.store.list<Approval>("approvals"))) {
    if (ap.workflow !== ctx.workflow.id || ap.acts[0]?.op !== PO_ACT) continue;
    const code = (ap.acts[0].input?.body as any)?.[0]?.lineItems?.[0]?.code;
    if (typeof code !== "string") continue;
    const open = ["pending", "running", "needs-check"].includes(ap.status);
    const recent = ["done", "rejected"].includes(ap.status) && ctx.now.getTime() - ms(ap.decided ?? ap.created) < REORDER_WINDOW;
    if (open || recent) out.add(code);
  }
  return out;
}

/** Hourly: where open orders need more of a rule's product than Cin7 has available, queue a purchase order for approval. */
export async function stockCheck(ctx: Ctx<Settings>) {
  const rules = ctx.settings.reorder ?? [];
  if (!rules.length) return { queued: 0, skipped: "no reorder rules in settings" };
  checkReorder(rules);
  const need = new Map<string, number>();
  for (const o of Object.values(await ctx.store.list<Order>("orders"))) {
    if (o.status !== "open") continue;
    for (const l of o.lines) need.set(l.code, (need.get(l.code) ?? 0) + Math.max(0, l.qty - l.qtyShipped));
  }
  const today = day(ctx.now);
  const inFlight = await ordersInFlight(ctx);
  let queued = 0;
  for (const rule of rules) {
    const n = need.get(rule.code) ?? 0;
    if (n <= 0) continue;
    if (inFlight.has(rule.code)) continue;   // a purchase order for this code is already waiting, or was raised within the window
    const avail = await stockAvailable(ctx, rule.code);
    if (avail >= n) continue;
    await queuePurchaseOrder(ctx, rule, today, n, avail);
    queued++;
  }
  ctx.log(`stock-check: ${queued} purchase orders queued for approval`);
  return { queued };
}

/** Daily: a DRAFT Xero invoice for each shipped order, once. Never authorised or sent by the cron. */
export async function invoice(ctx: Ctx<Settings>) {
  if (ctx.settings.invoice?.on_ship !== "xero-invoice-draft") return { drafted: 0, skipped: "invoice.on_ship is not xero-invoice-draft" };
  const due = Object.values(await ctx.store.list<Order>("orders")).filter((o) => o.status === "shipped" && !o.xero_invoice);
  let drafted = 0, failed = 0;
  for (const o of due) {
    try {
      const id = await draftInvoice(ctx, o, await contactFor(ctx, o));
      await ctx.store.put("orders", o.key, { ...o, xero_invoice: id, error: undefined });
      drafted++;
    } catch (e: any) {
      failed++;
      await ctx.store.put("orders", o.key, { ...o, error: `invoice not drafted: ${String(e?.message ?? e).slice(0, 160)}` });
    }
  }
  ctx.log(`invoice: ${drafted} drafted, ${failed} failed`);
  return { drafted, failed };
}

/** Daily: each authorised or paid supplier bill is matched to a Cin7 purchase order by reference. Mismatches are recorded for a person. */
export async function billMatch(ctx: Ctx<Settings>) {
  const bills = (await supplierBills(ctx)).filter((b) => ["AUTHORISED", "PAID"].includes(String(b.Status)));
  const byRef = new Map<string, any>();
  for (const po of await purchaseOrders(ctx)) {
    const r = String(po?.reference ?? "").trim().toLowerCase();
    if (r && !byRef.has(r)) byRef.set(r, po);
  }
  let matched = 0, mismatched = 0;
  for (const b of bills) {
    const key = `bill-${String(b.InvoiceID ?? "")}`;
    if (!/^bill-[0-9a-f-]{36}$/i.test(key)) continue;
    const ref = text(b.Reference, 100).toLowerCase();
    const po = ref ? byRef.get(ref) : undefined;
    const reason = !po ? "no Cin7 purchase order carries this reference"
      : text(b.Contact?.Name, 200).toLowerCase() !== text(po.company, 200).toLowerCase() ? "supplier differs from the purchase order"
      : Math.abs(num(b.SubTotal) - num(po.productTotal)) > 0.01 ? "amount before tax differs from the purchase order"
      : null;
    if (reason) mismatched++; else matched++;
    await ctx.store.put("matches", key, { bill: key, po_reference: ref || null, status: reason ? "mismatch" : "matched", reason, checked: day(ctx.now) });
  }
  ctx.log(`bill-match: ${matched} matched, ${mismatched} for a person`);
  return { matched, mismatched };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  intake, "stock-check": stockCheck, invoice, "bill-match": billMatch,
};
