// The fulfilment run's three crons. Each reads, stores or queues; none sends. A shipment is queued as a live
// operation and waits for a person to approve it in the CRM shell. Judgment (pick, pack, short-stock calls) stays with the person.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { type Order, type Settings, WAREHOUSE } from "./types.ts";
import * as unleashed from "./adapters/unleashed.ts";
import { toOrder, shipmentBody, dispatchSummary } from "./adapters/unleashed.ts";

function checked(ctx: Ctx<Settings>) {
  const u = ctx.settings.unleashed;
  if (!u || !WAREHOUSE.test(u.warehouse_code ?? "") || !u.order_status) throw new Error("fulfil: settings.unleashed needs warehouse_code and order_status");
}

/** Every 10 minutes: new sales orders in the business's status. Each order is stored once; a re-run adds nothing twice. */
export async function intake(ctx: Ctx<Settings>) {
  checked(ctx);
  let added = 0, skipped = 0;
  for (const row of await unleashed.salesOrders(ctx)) {
    const o = toOrder(row, ctx.now);
    if (!o) { skipped++; continue; }
    if (await ctx.store.get("orders", o.key)) continue;
    await ctx.store.put("orders", o.key, o);
    added++;
  }
  ctx.log(`intake: ${added} new, ${skipped} skipped (failed validation)`);
  return { added, skipped };
}

/** Every 30 minutes: check new and short orders against stock in the warehouse, oldest first. Ready orders reserve their stock. */
export async function stockCheck(ctx: Ctx<Settings>) {
  checked(ctx);
  const left = new Map((await unleashed.stockOnHand(ctx)).map((s) => [s.sku, s.available]));
  const open = Object.values(await ctx.store.list<Order>("orders"))
    .filter((o) => o.status === "new" || o.status === "short")
    .sort((a, b) => a.seen.localeCompare(b.seen));
  let ready = 0, short = 0;
  for (const o of open) {
    const lacking = [...new Set(o.lines.filter((l) => (left.get(l.sku) ?? 0) < l.qty).map((l) => l.sku))];
    if (lacking.length) { await ctx.store.put("orders", o.key, { ...o, status: "short", short: lacking }); short++; continue; }
    for (const l of o.lines) left.set(l.sku, (left.get(l.sku) ?? 0) - l.qty);
    await ctx.store.put("orders", o.key, { ...o, status: "ready", short: undefined }); ready++;
  }
  ctx.log(`stock-check: ${ready} ready, ${short} short`);
  return { ready, short };
}

/** Hourly: each ready order's shipment is queued for approval once. Approved shipments are marked dispatched; failed and rejected ones are never requeued by a cron. */
export async function dispatch(ctx: Ctx<Settings>) {
  checked(ctx);
  let queued = 0, dispatched = 0;
  for (const o of Object.values(await ctx.store.list<Order>("orders"))) {
    if (o.status === "queued" && o.dispatch_approval) {
      const ap = await ctx.store.get<Approval>("approvals", o.dispatch_approval);
      if (ap?.status === "done") { await ctx.store.put("orders", o.key, { ...o, status: "dispatched" }); dispatched++; }
      else if (ap?.status === "failed" || ap?.status === "rejected") await ctx.store.put("orders", o.key, { ...o, status: ap.status });
      continue;
    }
    if (o.status !== "ready") continue;
    const id = await ctx.queue({ platform: "unleashed", op: "docs.post_SalesShipments", key: `dispatch:${o.number}`,
      summary: dispatchSummary(o), input: { body: shipmentBody(ctx, o) } }, dispatchSummary(o));
    await ctx.store.put("orders", o.key, { ...o, status: "queued", dispatch_approval: id });
    queued++;
  }
  ctx.log(`dispatch: ${queued} queued, ${dispatched} dispatched`);
  return { queued, dispatched };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, "stock-check": stockCheck, dispatch };
