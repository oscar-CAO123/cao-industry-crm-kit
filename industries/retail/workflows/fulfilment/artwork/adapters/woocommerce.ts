// WooCommerce: read the store's products (draft) and add mockup images to a product (live, queued only).
// Field names from the WooCommerce REST v3 reference: products batch takes create / update / delete arrays, and
// each product's images take id, src, alt and position. Only the operations mapped in core/sdk/platforms/woocommerce.
import { createHash } from "node:crypto";
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import type { ProductRow, MockupSet, Settings } from "../types.ts";

const P = "woocommerce";
const MAX_ALT = 125;
const MAX_URL = 2000;

/** A WooCommerce product id: a positive integer. */
export function productId(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new Error("woocommerce: bad product id");
  return n;
}

/** An image must be an https URL with no login in it, on one of the business's own asset hosts, so the store fetches it from a place the business controls. */
export function httpsUrl(v: unknown, hosts: readonly string[]): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > MAX_URL) throw new Error("image URL is missing or too long");
  let u: URL;
  try { u = new URL(s); } catch { throw new Error("image is not a URL"); }
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("image must be an https URL with no login in it");
  if (!hosts.some((h) => h.toLowerCase() === u.hostname.toLowerCase())) throw new Error("image host is not one of asset_hosts in settings");
  return u.toString();
}

/** Alt text: one line of plain text, at most 125 characters. */
export function altText(v: unknown): string {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (s.length > MAX_ALT) throw new Error(`alt text is over ${MAX_ALT} characters`);
  return s;
}

const PER_PAGE = 100;
const MAX_PAGES = 20;

/** Read the store's products, page by page (100 a page, at most 20 pages). Every read is a draft operation. */
export async function listProducts(ctx: Ctx<Settings>): Promise<ProductRow[]> {
  const out: ProductRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await ctx.draft<any[]>({
      platform: P,
      op: "docs.get_products",
      input: { params: { page, per_page: PER_PAGE } },
      summary: `read the store's products (page ${page})`,
    });
    const rows = Array.isArray(r.data) ? r.data : [];
    for (const x of rows) {
      if (!Number.isInteger(x?.id)) continue;
      out.push({
        id: x.id,
        name: String(x.name ?? "").slice(0, 200),
        sku: String(x.sku ?? "").slice(0, 100),
        images: (Array.isArray(x.images) ? x.images : []).map((i: any) => ({ id: Number(i?.id), src: String(i?.src ?? "") })),
      });
    }
    if (rows.length < PER_PAGE) break;
  }
  return out;
}

/**
 * The live operation for one mockup set: the product's existing images kept by id, the new images appended in order.
 * The key comes from the product and the new images only, so a set that is already queued or approved is never queued twice.
 */
export function mockupAct(p: ProductRow, set: MockupSet, max: number, hosts: readonly string[]): Act {
  const id = productId(set.product_id);
  const fresh = (Array.isArray(set.images) ? set.images : []).map((i) => ({ src: httpsUrl(i.src, hosts), alt: altText(i.alt) }));
  if (!fresh.length) throw new Error("the mockup set has no images");
  const kept = p.images.filter((i) => Number.isInteger(i.id)).map((i) => ({ id: i.id }));
  if (kept.length + fresh.length > max) throw new Error(`would hold ${kept.length + fresh.length} images, the limit is ${max}`);
  const images = [...kept, ...fresh.map((f, n) => ({ ...f, position: kept.length + n }))];
  const digest = createHash("sha256").update(JSON.stringify({ id, fresh })).digest("hex").slice(0, 12);
  const s = fresh.length === 1 ? "" : "s";
  return {
    platform: P,
    op: "docs.post_products_batch",
    input: { body: { update: [{ id, images }] } },
    summary: `add ${fresh.length} mockup image${s} to ${p.name || "product " + id} (${kept.length} existing kept)`,
    key: `listing:${id}:${digest}`,
  };
}
