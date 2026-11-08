// The retail artwork workflow's two crons. Both are deterministic: catalogue reads, listing queues.
// Nothing here changes a live listing. The agent makes the mockups (SKILL.md) and writes them to the mockups record;
// listing queues each set as a batch update, and a person approves it in the CRM shell before the store changes.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { MockupSet, ProductRow, Settings } from "./types.ts";
import { listProducts, mockupAct, productId } from "./adapters/woocommerce.ts";

/** Hourly: read the store's products, record each one, and report which approved mockups are now live. */
export async function catalogue(ctx: Ctx<Settings>) {
  const rows = await listProducts(ctx);
  for (const p of rows) await ctx.store.put("products", String(p.id), p);
  const sets = Object.values(await ctx.store.list<MockupSet>("mockups"));
  const isLive = (set: MockupSet) => {
    const p = rows.find((r) => r.id === set.product_id);
    return !!p && set.images.every((i) => p.images.some((x) => x.src === i.src));
  };
  const live = sets.filter(isLive).length;
  const result = {
    products: rows.length,
    without_images: rows.filter((p) => p.images.length === 0).length,
    mockups_live: live,
    mockups_waiting: sets.length - live,
  };
  ctx.log(`catalogue: ${result.products} products, ${result.mockups_live} mockup sets live, ${result.mockups_waiting} waiting`);
  return result;
}

/** Every 30 minutes: queue the listing update for each mockup set. Queuing is idempotent, so a set is queued once. */
export async function listing(ctx: Ctx<Settings>) {
  const sets = Object.values(await ctx.store.list<MockupSet>("mockups"));
  const max = ctx.settings.max_images ?? 10;
  let ready = 0, rejected = 0, skipped = 0;
  for (const set of sets) {
    let id: number;
    try { id = productId(set.product_id); } catch (e: any) { rejected++; ctx.log(`listing: rejected a set: ${e.message}`); continue; }
    const p = await ctx.store.get<ProductRow>("products", String(id));
    if (!p) { skipped++; continue; } // the catalogue has not read this product yet
    let act;
    try { act = mockupAct(p, set, max); } catch (e: any) { rejected++; ctx.log(`listing: rejected product ${id}: ${e.message}`); continue; }
    await ctx.queue(act);
    ready++;
  }
  ctx.log(`listing: ${ready} ready for approval, ${rejected} rejected, ${skipped} waiting for the catalogue`);
  return { ready_for_approval: ready, rejected, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { catalogue, listing };
