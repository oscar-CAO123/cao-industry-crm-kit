// WooCommerce: the online store's product list. Read only here: this workflow queues no WooCommerce write.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Product, text, num } from "../types.ts";

const P = "woocommerce";

export const woocommerce = {
  id: P,
  /** The first page of the product list (WooCommerce returns 10 by default; no per_page or page is sent). */
  async products(ctx: Ctx<Settings>): Promise<Product[]> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_products", summary: "read products (first page)" });
    const rows: any[] = Array.isArray(r.data) ? r.data : [];
    return rows.map((i): Product => {
      const sku = text(i?.sku, 100);
      return { platform: P, code: sku || `#${text(i?.id, 20)}`, guid: text(i?.id, 20) || undefined, name: text(i?.name, 500) || undefined,
               sku: sku || undefined, price: num(i?.regular_price) };
    });
  },
};
