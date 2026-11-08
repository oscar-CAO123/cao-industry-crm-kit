// Unleashed: where a bill of materials lives. Bills, products and stock on hand, through the kit's mapped operations.
// Field names come from the vendor's API reference (BillOfMaterials, Products, StockOnHand). The product filter
// matches the start of a code, so the exact match is checked here. Every call goes through the SDK gate, which signs
// each request (api-auth-id, api-auth-signature, client-type) from the UNLEASHED_* secrets.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type BomPart, type BomRecord, type Settings, guid, keyOf, productCode } from "../types.ts";

const P = "unleashed";

/** The body Unleashed takes for a new or revised bill. Line numbers start at 1. An update (PUT) also carries the bill's own Guid, which Unleashed requires. */
export function billBody(parentGuid: string, lines: { guid: string; qty: number }[], billGuid?: string) {
  return {
    ...(billGuid ? { Guid: billGuid } : {}),
    Product: { Guid: parentGuid },
    BillOfMaterialsLines: lines.map((l, i) => ({ LineNumber: i + 1, Product: { Guid: l.guid }, Quantity: l.qty })),
  };
}

/** An active product by its exact code, or undefined. */
export async function findProduct(ctx: Ctx<Settings>, code: string): Promise<{ guid: string } | undefined> {
  const c = productCode(code);
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_Products", summary: `find product ${c}`,
    input: { params: { productCode: c, includeObsolete: "false", brief: "true" } } });
  if ((r.data?.Pagination?.NumberOfPages ?? 1) > 1) throw new Error("more than one page of products matches this code");
  const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : [];
  const hit = items.find((p) => p?.ProductCode === c);
  return hit ? { guid: guid(hit.Guid, "product") } : undefined;
}

/** The active bill for a product, if Unleashed already holds one. */
export async function billFor(ctx: Ctx<Settings>, parentGuid: string): Promise<{ guid: string; lines: BomPart[] } | undefined> {
  const pg = guid(parentGuid, "product");
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_BillOfMaterials", summary: "find existing bill", input: { params: { productGuid: pg } } });
  const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : [];
  const hit = items.find((b) => String(b?.Product?.Guid ?? "").toLowerCase() === pg.toLowerCase() && b.Obsolete !== true);
  if (!hit) return undefined;
  const lines = (hit.BillOfMaterialsLines ?? []).map((l: any) => ({ code: "", guid: guid(l?.Product?.Guid, "component"), qty: Number(l.Quantity) }));
  return { guid: guid(hit.Guid, "bill"), lines };
}

/** Stock available across all warehouses for one product. AvailableQty already nets off allocations. */
export async function availableFor(ctx: Ctx<Settings>, productGuid: string): Promise<number> {
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_StockOnHand_productGuid_AllWarehouses", summary: "stock on hand",
    input: { params: { productGuid: guid(productGuid, "product") } } });
  const rows: any[] = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.Items) ? r.data.Items : [];
  return rows.reduce((a, x) => a + (Number(x?.AvailableQty) || 0), 0);
}

/** Create a bill in Unleashed. An internal record only: no assembly and no order is made. */
export async function createBill(ctx: Ctx<Settings>, parentGuid: string, lines: BomPart[]): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "docs.post_BillOfMaterials", summary: `create bill of materials with ${lines.length} components`,
    input: { body: billBody(parentGuid, lines) } });
  return guid(r.data?.Guid, "bill");
}

/** A change to a live bill. Queued for a person to approve; no cron sends it. Keyed by the change, so a re-run queues it once. */
export function queueRevision(ctx: Ctx<Settings>, rec: BomRecord, lines: BomPart[], hash: string) {
  const bill = guid(rec.guid, "bill");
  return ctx.queue({
    platform: P, op: "docs.put_BillOfMaterials_billOfMaterialsGuid", key: keyOf(`bom-rev.${rec.parent}.${hash}`),
    input: { params: { billOfMaterialsGuid: bill }, body: billBody(rec.parent_guid, lines, bill) },
    summary: `Update the bill of materials for ${rec.parent} in Unleashed to ${lines.length} components`,
  }, `Update the bill of materials for ${rec.parent} in Unleashed (${lines.length} components)`);
}
