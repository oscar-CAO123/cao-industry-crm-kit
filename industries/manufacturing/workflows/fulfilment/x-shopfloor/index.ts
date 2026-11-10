// The shop-floor workflow's three crons. Each reads and drafts into the workflow store; a finished build is only ever
// queued for approval, and a person approves it in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { listAssemblies, listStock, completeAssembly } from "./adapters/unleashed.ts";
import { GUID, productCode, str, type Settings } from "./types.ts";

/** Records whether every page of builds was read. When the platform holds more, the builds on later pages are not on the
 *  board and cannot be queued by this workflow; the record says so, rather than the gap going unnoticed. */
async function coverage(ctx: Ctx<Settings>, pages: number) {
  const partial = pages > 1;
  await ctx.store.put("shopfloor", "coverage", { at: ctx.now.toISOString(), pages, partial,
    note: partial ? `the platform holds ${pages} pages of builds; only the first page was read` : "every page of builds was read" });
  if (partial) ctx.log(`builds: ${pages} pages on the platform, only the first read`);
}

/** Every 30 minutes: open builds from the platform onto the shop-floor board (a draft in the store). */
export async function schedule(ctx: Ctx<Settings>) {
  const { builds, pages } = await listAssemblies(ctx);
  const rows = builds.map((b) => ({
    guid: str(b.Guid, 40), number: str(b.AssemblyNumber, 40), status: str(b.AssemblyStatus, 60),
    product: str(productCode(b.Product), 80), quantity: Number(b.Quantity) || 0, date: str(b.AssemblyDate, 20),
  }));
  await ctx.store.put("shopfloor", "board", { at: ctx.now.toISOString(), builds: rows, partial: pages > 1 });
  await coverage(ctx, pages);
  ctx.log(`schedule: ${rows.length} builds on the board`);
  return { builds: rows.length };
}

/** Every 6 hours: components below their minimum level, from stock on hand (a draft in the store). */
export async function stock(ctx: Ctx<Settings>) {
  const rows = await listStock(ctx);
  const short: { code: string; on_hand: number; minimum: number }[] = [];
  for (const [code, minimum] of Object.entries(ctx.settings.reorder_levels ?? {})) {
    if (!Number.isFinite(minimum) || minimum < 0) continue;
    const onHand = rows
      .filter((r) => str(r.ProductCode, 100) === code)
      .reduce((sum, r) => sum + (Number(r.QtyOnHand) || 0), 0);
    if (onHand < minimum) short.push({ code: str(code, 100), on_hand: onHand, minimum });
  }
  await ctx.store.put("shopfloor", "stock", { at: ctx.now.toISOString(), short });
  ctx.log(`stock: ${short.length} components below minimum`);
  return { short: short.length };
}

/** Hourly: a build the floor has marked ready is queued for completion. Re-runs never queue it twice. */
export async function completeBuilds(ctx: Ctx<Settings>) {
  const { builds, pages } = await listAssemblies(ctx);
  await coverage(ctx, pages);
  let queued = 0;
  for (const b of builds) {
    const ready = b.AssemblyStatus === ctx.settings.ready_status || b.CustomAssemblyStatus === ctx.settings.ready_status;
    if (!ready || !GUID.test(String(b.Guid ?? ""))) continue;
    const summary = `Complete build ${str(b.AssemblyNumber, 40)}: ${str(productCode(b.Product), 80)} x ${Number(b.Quantity) || 0}`;
    await completeAssembly(ctx, String(b.Guid), summary);
    queued++;
  }
  ctx.log(`complete-builds: ${queued} ready builds queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  schedule, stock, "complete-builds": completeBuilds,
};
