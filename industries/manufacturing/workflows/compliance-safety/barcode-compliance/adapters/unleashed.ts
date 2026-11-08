// Unleashed: the product master. Reads the product list and single products (draft operations); a barcode change is
// built here as a live act and only ever queued by the cron, so a person approves it before it reaches the record.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Product, type Settings, isGuid } from "../types.ts";

const P = "unleashed";
const str = (v: unknown) => (v == null ? "" : String(v));

function toProduct(o: Record<string, any>): Product | undefined {
  const guid = str(o.Guid);
  if (!isGuid(guid)) return undefined;
  return { guid, code: str(o.ProductCode), description: str(o.ProductDescription), barcode: str(o.Barcode), obsolete: o.Obsolete === true, raw: o };
}

export const unleashed = {
  id: P,
  /** The first page of products (200 by default). `more` is true when the catalogue has further pages, which the kit cannot request yet. */
  async products(ctx: Ctx<Settings>): Promise<{ products: Product[]; more: boolean }> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_Products", summary: "read product list, first page" });
    const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : [];
    const products = items.map((o) => toProduct(o)).filter((p): p is Product => !!p);
    return { products, more: Number(r.data?.Pagination?.NumberOfPages ?? 1) > 1 };
  },
  /** One product as the platform holds it now. */
  async product(ctx: Ctx<Settings>, guid: string): Promise<Product> {
    if (!isGuid(guid)) throw new Error("unleashed: bad product id");
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_Products_productGuid", summary: `read product ${guid}`, input: { params: { productGuid: guid } } });
    const p = toProduct(r.data ?? {});
    if (!p || p.guid !== guid) throw new Error("unleashed: product did not come back as asked");
    return p;
  },
  /** The barcode update: the product as read, with only Barcode changed. */
  setBarcodeAct(p: Product, barcode: string): Act {
    return {
      platform: P, op: "docs.post_Products_id",
      input: { params: { productGuid: p.guid }, body: { ...p.raw, Barcode: barcode } },
      summary: `set barcode on ${p.code} to ${barcode}`,
      key: `barcode:${p.guid}:${barcode}`,
    };
  },
};
