// Square: the POS that holds the venue's drinks stock. Reads use GET endpoints. The one write is a physical-count
// batch, which the workflow only ever queues for approval (see workflow.json live_ops).
// Field names from Square's official connect-api-specification: ListLocationsResponse, ListCatalogResponse,
// CatalogItemVariation, RetrieveInventoryCountResponse, BatchChangeInventoryRequest, InventoryChange, InventoryPhysicalCount.
import crypto from "node:crypto";
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ID, qtyText, type Count, type Settings } from "../types.ts";

const P = "square";
const str = (v: unknown) => String(v ?? "");

export interface Loc { id: string; name: string }
export interface Item { id: string; name: string }

/** Active locations, narrowed to the settings list when one is given. */
export async function locations(ctx: Ctx<Settings>): Promise<Loc[]> {
  const r = await ctx.draft<any>({ platform: P, op: "api.ListLocations", summary: "read locations" });
  const want = ctx.settings.locations ?? [];
  return ((r.data?.locations ?? []) as any[])
    .filter((l) => ID.test(str(l?.id)) && l.status !== "INACTIVE" && (want.length === 0 || want.includes(str(l.id))))
    .map((l) => ({ id: str(l.id), name: str(l.name).slice(0, 120) }));
}

/** Drink variations with inventory tracking on, named as item plus variation. Reads catalog pages up to the cap. */
export async function trackedItems(ctx: Ctx<Settings>, max: number): Promise<Item[]> {
  const itemName = new Map<string, string>();
  const vars: { id: string; itemId: string; name: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "api.ListCatalog", summary: "read catalog items and variations",
      input: { params: { types: "ITEM,ITEM_VARIATION", ...(cursor ? { cursor } : {}) } } });
    for (const o of (r.data?.objects ?? []) as any[]) {
      if (!o || o.is_deleted || !ID.test(str(o.id))) continue;
      if (o.type === "ITEM") itemName.set(str(o.id), str(o.item_data?.name));
      else if (o.type === "ITEM_VARIATION" && o.item_variation_data?.track_inventory === true) {
        vars.push({ id: str(o.id), itemId: str(o.item_variation_data.item_id), name: str(o.item_variation_data.name) });
      }
    }
    cursor = r.data?.cursor ? str(r.data.cursor) : undefined;
    if (!cursor) break;
  }
  return vars.slice(0, max).map((v) => ({ id: v.id, name: [itemName.get(v.itemId), v.name].filter(Boolean).join(" ").slice(0, 160) || v.id }));
}

/** System stock of one tracked variation at each location (IN_STOCK only). */
export async function stockOf(ctx: Ctx<Settings>, catalogId: string) {
  if (!ID.test(catalogId)) throw new Error("square: bad catalog id");
  const r = await ctx.draft<any>({ platform: P, op: "api.RetrieveInventoryCount", summary: "read system stock",
    input: { params: { catalog_object_id: catalogId } } });
  return ((r.data?.counts ?? []) as any[])
    .filter((c) => c?.state === "IN_STOCK" && ID.test(str(c.location_id)) && /^\d{1,9}(\.\d{1,3})?$/.test(str(c.quantity)))
    .map((c) => ({ location_id: str(c.location_id), quantity: str(c.quantity), calculated_at: str(c.calculated_at) }));
}

/** The POS write for one count: a physical count per line, dated when it was taken. The key is stable, so a retry never double-counts. */
export function countBody(c: Count, now: Date) {
  const taken = Date.parse(c.taken_at);
  const occurred = Number.isNaN(taken) ? now.toISOString() : new Date(taken).toISOString();
  return {
    idempotency_key: crypto.createHash("sha256").update(`square-count:${c.id}`).digest("hex").slice(0, 40),
    ignore_unchanged_counts: true,
    changes: c.lines.map((l) => ({
      type: "PHYSICAL_COUNT",
      physical_count: { reference_id: c.id, catalog_object_id: l.catalog_object_id, state: "IN_STOCK",
                        location_id: c.location_id, quantity: qtyText(l.quantity), occurred_at: occurred },
    })),
  };
}
