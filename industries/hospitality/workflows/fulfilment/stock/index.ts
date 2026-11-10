// The hand-count drinks workflow's three crons. Each is deterministic: it reads, records and queues; it never changes the POS.
// Judgment (reading the owner's count sheet, deciding what a difference means) belongs to the agent in SKILL.md.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { locations, trackedItems, stockOf, countBody } from "./adapters/square.ts";
import { type Settings, type Count, type StockLevel, type Variance, countProblem, keyOf } from "./types.ts";

const MAX_ITEMS = 400;

/** Every 6 hours: read the system stock of each tracked drink at each active location. Reads and stores only. */
export async function snapshot(ctx: Ctx<Settings>) {
  const locs = await locations(ctx);
  if (!locs.length) { ctx.log("snapshot: no active locations"); return { locations: 0, items: 0, levels: 0 }; }
  const cap = Number(ctx.settings.max_variations);
  const items = await trackedItems(ctx, Math.min(Number.isFinite(cap) && cap > 0 ? cap : MAX_ITEMS, MAX_ITEMS));
  let levels = 0;
  for (const it of items) {
    for (const s of await stockOf(ctx, it.id)) {
      if (!locs.some((l) => l.id === s.location_id)) continue;
      await ctx.store.put("stock", keyOf(`${s.location_id}.${it.id}`),
        { location_id: s.location_id, catalog_object_id: it.id, name: it.name, quantity: s.quantity, calculated_at: s.calculated_at, seen_at: ctx.now.toISOString() } satisfies StockLevel);
      levels++;
    }
  }
  ctx.log(`snapshot: ${levels} levels for ${items.length} items at ${locs.length} locations`);
  return { locations: locs.length, items: items.length, levels };
}

/** Daily: read the current system count for each new hand count and write up the differences. Reads and records only. */
export async function reconcile(ctx: Ctx<Settings>) {
  const counts = Object.values(await ctx.store.list<Count>("counts")).filter((c) => c.status === "new");
  let reconciled = 0, rejected = 0;
  for (const c of counts) {
    const problem = countProblem(c);
    if (problem) { await ctx.store.put("counts", c.id, { ...c, status: "rejected", reason: problem } satisfies Count); rejected++; continue; }
    let differences = 0;
    for (const l of c.lines) {
      const sys = (await stockOf(ctx, l.catalog_object_id)).find((s) => s.location_id === c.location_id);
      const system = sys ? Number(sys.quantity) : null;
      const difference = system === null ? null : Math.round((l.quantity - system) * 1000) / 1000;
      if (difference !== null && difference !== 0) differences++;
      await ctx.store.put("variances", keyOf(`${c.id}.${l.catalog_object_id}`),
        { count: c.id, location_id: c.location_id, catalog_object_id: l.catalog_object_id, name: l.name, hand_count: l.quantity, system_count: system, difference } satisfies Variance);
    }
    await ctx.store.put("counts", c.id, { ...c, status: "reconciled", reconciled_at: ctx.now.toISOString(), differences } satisfies Count);
    reconciled++;
  }
  ctx.log(`reconcile: ${reconciled} reconciled, ${rejected} rejected`);
  return { reconciled, rejected };
}

/** Hourly: queue each reconciled count as physical counts for approval. The POS changes only when a person approves it. */
export async function postCounts(ctx: Ctx<Settings>) {
  let queued = 0, posted = 0;
  for (const c of Object.values(await ctx.store.list<Count>("counts"))) {
    if (c.status === "queued" && c.approval) {
      const ap = await ctx.store.get<Approval>("approvals", c.approval);
      if (ap?.status === "done") { await ctx.store.put("counts", c.id, { ...c, status: "posted" } satisfies Count); posted++; }
      continue;
    }
    if (c.status !== "reconciled") continue;
    const id = await ctx.queue({ platform: "square", op: "api.BatchChangeInventory", key: `count:${c.id}`, input: { body: countBody(c, ctx.now) },
      summary: `Post count ${c.id}: ${c.lines.length} lines at ${c.location_id}, ${c.differences ?? 0} differ from the system` });
    await ctx.store.put("counts", c.id, { ...c, status: "queued", approval: id } satisfies Count);
    queued++;
  }
  ctx.log(`post-counts: ${queued} queued, ${posted} posted`);
  return { queued, posted };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { snapshot, reconcile, "post-counts": postCounts };
