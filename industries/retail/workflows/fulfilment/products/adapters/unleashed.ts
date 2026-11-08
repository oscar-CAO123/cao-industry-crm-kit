// Unleashed: the inventory system that holds the product record and stock. Reads are draft operations.
// Marking a product obsolete can change what the B2B store shows, so it is only ever queued for approval.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Product, type StockLevel, GUID, CODE, text, num } from "../types.ts";

const P = "unleashed";

function toProduct(i: any): Product | undefined {
  const code = text(i?.ProductCode, 100);
  if (!CODE.test(code)) return undefined;
  const guid = GUID.test(String(i.Guid ?? "")) ? String(i.Guid) : undefined;
  return {
    platform: P, code, guid,
    name: text(i.ProductDescription, 500) || undefined,
    barcode: text(i.Barcode, 200) || undefined,
    price: num(i.DefaultSellPrice),
    obsolete: i.Obsolete === true,
  };
}

export const unleashed = {
  id: P,
  /** The first page of the product list (no page number is mapped, so only the first page is read). */
  async products(ctx: Ctx<Settings>): Promise<Product[]> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_Products", summary: "read products (first page)" });
    return (r.data?.Items ?? []).map(toProduct).filter((p: Product | undefined): p is Product => !!p);
  },
  /** The first page of stock on hand, one row per product per warehouse. */
  async stock(ctx: Ctx<Settings>): Promise<StockLevel[]> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_StockOnHand", summary: "read stock on hand (first page)" });
    const out: StockLevel[] = [];
    for (const i of r.data?.Items ?? []) {
      const code = text(i?.ProductCode, 100), qty = num(i?.QtyOnHand);
      if (!CODE.test(code) || qty === undefined) continue;
      out.push({ code, guid: GUID.test(String(i.ProductGuid ?? "")) ? String(i.ProductGuid) : undefined, warehouse: text(i.WarehouseCode, 15) || undefined, qty });
    }
    return out;
  },
  /** Queue one product to be marked obsolete. A person approves it; the cron never runs it. */
  async queueObsolete(ctx: Ctx<Settings>, p: Product): Promise<string> {
    if (!p.guid) throw new Error(`unleashed: ${p.code} has no Guid, so it cannot be marked obsolete`);
    return ctx.queue({
      platform: P, op: "docs.post_Products_Obsolete_productGuid", input: { params: { productGuid: p.guid } },
      key: `obsolete:${p.guid}`, summary: `Mark ${p.code} obsolete in Unleashed`,
    });
  },
};
