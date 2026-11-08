// Square: the stock record. Reads the catalogue, the adjustment reasons and the day's waste changes. The one write, an
// adjustment to WASTE, is only ever queued here: it runs when a person approves it.
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import { type CatalogItem, type Settings, type WasteEntry, ID, WASTE_REASON, idemKey } from "../types.ts";

const P = "square";
const PAGES = 20;

/** Every sellable variation at the business's location. Square pages through them with a cursor. */
export async function catalogue(ctx: Ctx<Settings>): Promise<CatalogItem[]> {
  const out: CatalogItem[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PAGES; i++) {
    const r = await ctx.draft<any>({ platform: P, op: "api.SearchCatalogItems", summary: "read catalogue items",
      input: { body: { enabled_location_ids: [ctx.settings.location_id], limit: 100, ...(cursor ? { cursor } : {}) } } });
    for (const item of r.data?.items ?? []) {
      const itemId = String(item.id ?? "");
      if (!ID.test(itemId)) continue;
      for (const v of item.item_data?.variations ?? []) {
        const vid = String(v.id ?? "");
        if (!ID.test(vid) || v.is_deleted) continue;
        out.push({
          variation_id: vid, item_id: itemId, track_inventory: v.item_variation_data?.track_inventory === true,
          name: String(v.item_variation_data?.name ?? item.item_data?.name ?? vid).slice(0, 120), seen: ctx.now.toISOString(),
        });
      }
    }
    cursor = r.data?.cursor;
    if (!cursor) break;
  }
  return out;
}

/** The adjustment reason types the seller has (standard, system and custom). */
export async function reasonTypes(ctx: Ctx<Settings>): Promise<string[]> {
  const r = await ctx.draft<any>({ platform: P, op: "api.ListInventoryAdjustmentReasons", summary: "read adjustment reasons" });
  return (r.data?.adjustment_reasons ?? []).filter((x: any) => !x.is_deleted).map((x: any) => String(x.id?.type ?? ""));
}

/** Waste adjustments since a time, at the business's location. Only the ones logged with the waste reason are kept. */
export async function wasteChanges(ctx: Ctx<Settings>, since: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PAGES; i++) {
    const r = await ctx.draft<any>({ platform: P, op: "api.BatchRetrieveInventoryChanges", summary: "read the day's inventory changes",
      input: { body: { location_ids: [ctx.settings.location_id], types: ["ADJUSTMENT"], updated_after: since, limit: 100, ...(cursor ? { cursor } : {}) } } });
    out.push(...(r.data?.changes ?? []));
    cursor = r.data?.cursor;
    if (!cursor) break;
  }
  return out.filter((c) => c.adjustment?.to_state === "WASTE" && c.adjustment?.reason_id?.type === WASTE_REASON);
}

/** The approval act: move a quantity of one variation from IN_STOCK to WASTE at the business's location. */
export function wasteAct(ctx: Ctx<Settings>, e: WasteEntry, item: CatalogItem, qty: string): Act {
  const loc = ctx.settings.location_id;
  return {
    platform: P, op: "api.BatchChangeInventory", key: `waste:${e.id}`, summary: `log ${qty} of ${item.name} as waste`,
    input: { body: { idempotency_key: idemKey(e.id), changes: [{ type: "ADJUSTMENT", adjustment: {
      catalog_object_id: item.variation_id, from_state: "IN_STOCK", to_state: "WASTE",
      from_location_id: loc, to_location_id: loc, quantity: qty, occurred_at: ctx.now.toISOString(),
      reason_id: { type: WASTE_REASON },
    } }] } },
  };
}
