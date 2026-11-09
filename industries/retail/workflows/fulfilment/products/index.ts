// The product data pipeline's three crons. Each reads and raises flags into its own store, or queues a retirement for approval.
// Nothing here changes a product on a platform: the only live operation (marking obsolete) waits in the approval queue.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Flag, type Product, flagKey } from "./types.ts";
import { unleashed } from "./adapters/unleashed.ts";
import { woocommerce } from "./adapters/woocommerce.ts";

/** Raise this run's flags of one kind, keep first_seen, and (when the read was complete) resolve open flags of that kind that did not come up again. */
async function raise(ctx: Ctx<Settings>, kind: Flag["kind"], found: Flag[], resolve = true): Promise<number> {
  const now = ctx.now.toISOString();
  const seen = new Set(found.map((f) => f.key));
  for (const f of found) {
    const prev = await ctx.store.get<Flag>("flags", f.key);
    await ctx.store.put("flags", f.key, { ...f, first_seen: prev?.first_seen ?? now, last_seen: now, status: "open" } satisfies Flag);
  }
  if (resolve) for (const [k, f] of Object.entries(await ctx.store.list<Flag>("flags"))) {
    if (f.kind === kind && f.status === "open" && !seen.has(k)) await ctx.store.put("flags", k, { ...f, status: "resolved", last_seen: now });
  }
  return found.length;
}

const flag = (kind: Flag["kind"], p: Product, reason: string, message: string): Flag => ({
  key: flagKey(kind, p.platform, p.code, reason), kind, platform: p.platform, code: p.code, reason, message,
  first_seen: "", last_seen: "", status: "open",
});

/** Every 30 minutes: product records missing a barcode, description, price or (WooCommerce) SKU. */
export async function check(ctx: Ctx<Settings>) {
  const u = await unleashed.products(ctx);
  const products: Product[] = [...u.items];
  let partial = u.partial;
  if (ctx.settings.woocommerce) {
    const w = await woocommerce.products(ctx);
    products.push(...w.items);
    partial = partial || w.partial;
  }
  const found: Flag[] = [];
  for (const p of products) {
    if (p.platform === "unleashed" && !p.barcode) found.push(flag("check", p, "missing-barcode", `${p.code} has no barcode`));
    if (!p.name) found.push(flag("check", p, "missing-description", `${p.code} has no description`));
    if (p.price === undefined) found.push(flag("check", p, "missing-price", `${p.code} has no price`));
    if (p.platform === "woocommerce" && !p.sku) found.push(flag("check", p, "missing-sku", `WooCommerce product ${p.guid ?? "?"} has no SKU`));
  }
  // A product record is whole on the page it sits on, so its flags are right; only resolving is unsafe on a partial read.
  const n = await raise(ctx, "check", found, !partial);
  ctx.log(`check: ${n} open record gaps across ${products.length} products${partial ? " (first page only: open flags were not resolved)" : ""}`);
  return { open: n, products: products.length, partial };
}

/** Every two hours: products whose total on hand, across warehouses, is at or below the low-stock level. */
export async function stock(ctx: Ctx<Settings>) {
  const low = ctx.settings.low_stock_qty ?? 5;
  const s = await unleashed.stock(ctx);
  // A product's rows can sit on later pages, so its total can be short: on a partial read no low-stock flag is raised or resolved.
  if (s.partial) { ctx.log("stock: first page only, so no low-stock flags were raised or resolved"); return { low: 0, partial: true }; }
  const totals = new Map<string, number>();
  for (const l of s.levels) totals.set(l.code, (totals.get(l.code) ?? 0) + l.qty);
  const found: Flag[] = [];
  for (const [code, qty] of totals) {
    if (qty > low) continue;
    const p: Product = { platform: "unleashed", code };
    found.push(flag("stock", p, "low-stock", `${code} has ${qty} on hand (low-stock level ${low})`));
  }
  const n = await raise(ctx, "stock", found);
  ctx.log(`stock: ${n} products at or below ${low}`);
  return { low: n };
}

/** Weekly: queue an obsolete approval for each product the owner has listed for retirement. A person approves each one. */
export async function retire(ctx: Ctx<Settings>) {
  const codes = new Set((ctx.settings.retire_codes ?? []).map(String));
  if (!codes.size) return { queued: 0 };
  let queued = 0;
  for (const p of (await unleashed.products(ctx)).items) {
    if (!codes.has(p.code) || !p.guid || p.obsolete) continue;
    await unleashed.queueObsolete(ctx, p);
    queued++;
  }
  ctx.log(`retire: ${queued} queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { check, stock, retire };
