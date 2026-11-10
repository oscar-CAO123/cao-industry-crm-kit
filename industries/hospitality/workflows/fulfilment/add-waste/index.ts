// The wastage workflow's three crons. Each reads, drafts or queues; none sends. A person approves every stock change.
// Judgment (reading the bin photo, matching it to a catalogue item, estimating the quantity) belongs to the agent skill in
// SKILL.md, which writes a waste entry into the store; logWaste checks it before anything is queued.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type CatalogItem, type DaySummary, type Settings, type WasteEntry, ENTRY_ID, ID, WASTE_REASON, cleanQty, day } from "./types.ts";
import * as square from "./adapters/square.ts";

const DAY = 864e5;

/** Hourly: the catalogue items an identified photo is matched against, and the adjustment reasons available. */
export async function catalogue(ctx: Ctx<Settings>) {
  const items = await square.catalogue(ctx);
  const types = await square.reasonTypes(ctx);
  for (const it of items) await ctx.store.put("waste-catalogue", it.variation_id, it);
  await ctx.store.put("waste-reasons", "current", { types, at: ctx.now.toISOString() });
  ctx.log(`catalogue: ${items.length} variations, waste reason ${types.includes(WASTE_REASON) ? "present" : "missing"}`);
  return { items: items.length, waste_reason: types.includes(WASTE_REASON) };
}

/** Every 10 minutes: queue each identified waste entry for approval. Anything that does not check out is parked, not queued. */
export async function logWaste(ctx: Ctx<Settings>) {
  const reasons = await ctx.store.get<{ types: string[] }>("waste-reasons", "current");
  if (!reasons?.types.includes(WASTE_REASON)) {
    ctx.log(`log-waste: the ${WASTE_REASON} reason is not in the catalogue yet, nothing queued`);
    return { queued: 0, held: 0 };
  }
  const max = ctx.settings.max_quantity ?? 1000;
  let queued = 0, held = 0;
  for (const [key, e] of Object.entries(await ctx.store.list<WasteEntry>("waste"))) {
    if (e.status !== "identified" || !ENTRY_ID.test(key) || e.id !== key) continue;
    const item = ID.test(String(e.variation_id)) ? await ctx.store.get<CatalogItem>("waste-catalogue", e.variation_id) : undefined;
    const qty = cleanQty(e.quantity, max);
    const problem = !item ? "the photo's item is not in the catalogue: match it again" : !qty ? `quantity must be above 0 and no more than ${max}` : undefined;
    if (problem || !item || !qty) {
      held++;
      await ctx.store.put("waste", key, { ...e, status: "needs-review", problem } satisfies WasteEntry);
      continue;
    }
    const note = e.note ? `: ${String(e.note).slice(0, 80)}` : "";
    const approval = await ctx.queue(square.wasteAct(ctx, e, item, qty), `Log ${qty} of ${item.name} as waste at ${ctx.settings.business_name ?? "the business"}${note}`);
    await ctx.store.put("waste", key, { ...e, status: "queued", approval, problem: undefined } satisfies WasteEntry);
    queued++;
  }
  ctx.log(`log-waste: ${queued} queued for approval, ${held} need review`);
  return { queued, held };
}

/** Daily: summarise the last day's waste adjustments into the store. Nothing is sent or changed in Square. */
export async function review(ctx: Ctx<Settings>) {
  const since = new Date(ctx.now.getTime() - DAY).toISOString();
  const changes = await square.wasteChanges(ctx, since);
  const sums = new Map<string, number>();
  for (const c of changes) {
    const vid = String(c.adjustment?.catalog_object_id ?? "");
    const q = Number(c.adjustment?.quantity);
    if (!ID.test(vid) || !(q > 0)) continue;
    sums.set(vid, (sums.get(vid) ?? 0) + q);
  }
  const items: DaySummary["items"] = [];
  for (const [vid, quantity] of sums) {
    const name = (await ctx.store.get<CatalogItem>("waste-catalogue", vid))?.name ?? vid;
    items.push({ variation_id: vid, name, quantity: Math.round(quantity * 1000) / 1000 });
  }
  const summary: DaySummary = { date: day(ctx.now), changes: changes.length, items, at: ctx.now.toISOString() };
  await ctx.store.put("waste-days", summary.date, summary);
  ctx.log(`review: ${changes.length} waste adjustments on ${summary.date}`);
  return { changes: changes.length, items: items.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { catalogue, "log-waste": logWaste, review };
