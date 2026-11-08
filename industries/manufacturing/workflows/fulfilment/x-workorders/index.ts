// The work-orders workflow's three crons. Each reads or drafts in Unleashed; none sends anything or places a supplier order.
// Completing a work order moves stock, so the complete cron only queues it for a person to approve.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { DAY, CODE, day, keyOf, type Settings } from "./types.ts";
import { parkedOrders, stockAt, raiseParked, completeAct } from "./adapters/unleashed.ts";

function checkSettings(s: Settings) {
  if (!CODE.test(s.warehouse_code ?? "")) throw new Error("work-orders: warehouse_code is not a valid Unleashed code");
  for (const p of s.production_plan ?? []) {
    if (!CODE.test(p.product_code) || !(p.units_per_day > 0 && p.units_per_day <= 100000)) throw new Error("work-orders: bad production_plan entry");
  }
  for (const c of s.components ?? []) {
    if (!CODE.test(c.product_code) || !(c.min >= 0) || !(c.max >= c.min)) throw new Error("work-orders: bad components entry");
  }
}

/** Daily: park one work order for each planned product that has none open for this plan horizon. */
export async function plan(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const horizon = ctx.settings.horizon_days ?? 30;
  const due = day(new Date(ctx.now.getTime() + horizon * DAY));
  const open = await parkedOrders(ctx);
  let raised = 0, covered = 0;
  for (const p of ctx.settings.production_plan) {
    const key = keyOf(`${p.product_code}:${due}`);
    if (open.some((o) => o.product_code === p.product_code) || (await ctx.store.get("raised", key))) { covered++; continue; }
    const quantity = Math.round(p.units_per_day * horizon * 100) / 100;
    const guid = await raiseParked(ctx, p.product_code, quantity, due, `Raised from the production plan for ${horizon} days`);
    // Remember the raise at once: a later run reuses it instead of parking another.
    await ctx.store.put("raised", key, { product_code: p.product_code, due, guid, at: ctx.now.toISOString() });
    raised++;
  }
  ctx.log(`plan: ${raised} raised, ${covered} already covered`);
  return { raised, covered };
}

/** Every two hours: read component stock and list what is below its minimum, for the buyer. Orders nothing. */
export async function materials(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const onHand = new Map((await stockAt(ctx)).map((s) => [s.product_code, s.qty_on_hand]));
  const below = ctx.settings.components
    .filter((c) => (onHand.get(c.product_code) ?? 0) < c.min)
    .map((c) => {
      const have = onHand.get(c.product_code) ?? 0;
      return { product_code: c.product_code, on_hand: have, min: c.min, max: c.max, to_order: Math.max(0, c.max - have) };
    });
  await ctx.store.put("shortfalls", "latest", { at: ctx.now.toISOString(), items: below });
  ctx.log(`materials: ${below.length} component(s) below minimum`);
  return { below_minimum: below };
}

/** Hourly: queue completion of each parked work order whose due date has passed. A person approves each one. */
export async function complete(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  if (ctx.settings.complete_when_due === false) return { queued: 0, skipped: "complete_when_due is off" };
  const today = day(ctx.now);
  const due = (await parkedOrders(ctx)).filter((o) => o.due && o.due <= today);
  for (const o of due) await ctx.queue(completeAct(o), `Complete work order ${o.number} (${o.quantity} x ${o.product_code}) in Unleashed`);
  ctx.log(`complete: ${due.length} due, queued for approval`);
  return { queued: due.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { plan, materials, complete };
