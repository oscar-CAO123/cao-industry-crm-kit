// The lot trace workflow's four crons. Each reads or writes only its own internal store; the one platform write
// (a stock transfer into quarantine) is only ever queued for approval. Judgment (what to hold, what to tell a customer) belongs
// to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, Hold } from "./types.ts";
import { PRODUCT, CODE, guidOf } from "./types.ts";
import { batches, serials, positions, audits, holdTransfer } from "./adapters/unleashed.ts";

const inScope = (ctx: Ctx<Settings>, warehouse: string) => !ctx.settings.warehouse_codes?.length || ctx.settings.warehouse_codes.includes(warehouse);

/** Every 30 minutes: batch and serial records into the lot index. */
export async function lotSync(ctx: Ctx<Settings>) {
  const lots = (await batches(ctx)).filter((l) => inScope(ctx, l.warehouse));
  const serial = (await serials(ctx)).filter((s) => inScope(ctx, s.warehouse));
  for (const l of lots) await ctx.store.put("lots", l.guid, l);
  for (const s of serial) await ctx.store.put("serials", s.guid, s);
  ctx.log(`lot-sync: ${lots.length} batches, ${serial.length} serials`);
  return { batches: lots.length, serials: serial.length };
}

/** Hourly: stock on hand by product and warehouse, for finding where a lot's stock is now. */
export async function stockPosition(ctx: Ctx<Settings>) {
  const rows = (await positions(ctx)).filter((p) => inScope(ctx, p.warehouse));
  for (const p of rows) await ctx.store.put("positions", p.guid, p);
  ctx.log(`stock-position: ${rows.length} positions`);
  return { positions: rows.length };
}

/** Nightly: stock counts and adjustments into the audit register. */
export async function auditRegister(ctx: Ctx<Settings>) {
  const rows = (await audits(ctx)).filter((a) => inScope(ctx, a.warehouse));
  for (const a of rows) await ctx.store.put("audit", a.guid, a);
  ctx.log(`audit-register: ${rows.length} entries`);
  return { entries: rows.length };
}

/** Every 15 minutes: queue a quarantine transfer for each new hold. Holds that fail validation are skipped, never queued. */
export async function quarantine(ctx: Ctx<Settings>) {
  let queued = 0, skipped = 0;
  const to = ctx.settings.quarantine_warehouse;
  for (const raw of Object.values(await ctx.store.list<Hold>("holds"))) {
    if (raw.queued) continue;
    const h: Hold = { ...raw, qty: Number(raw.qty) };
    const ok = !!guidOf(h.guid) && PRODUCT.test(h.product) && CODE.test(h.from) && CODE.test(to) && h.from !== to
      && Number.isFinite(h.qty) && h.qty > 0 && h.qty <= 1e9;
    if (!ok) { skipped++; continue; }
    await ctx.queue(holdTransfer(ctx, h));
    await ctx.store.put("holds", h.guid, { ...h, queued: ctx.now.toISOString() });
    queued++;
  }
  ctx.log(`quarantine: ${queued} queued, ${skipped} skipped`);
  return { queued, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "lot-sync": lotSync, "stock-position": stockPosition, "audit-register": auditRegister, quarantine,
};
