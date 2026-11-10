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

/** Unleashed lists 200 rows a page and the reads send no page number, so a read is partial when more pages are indicated. */
const PAGE_ROWS = 200;
const partialRead = (data: any, rows: unknown[]) => Number(data?.Pagination?.NumberOfPages ?? 1) > 1 || rows.length >= PAGE_ROWS;

export const unleashed = {
  id: P,
  /** The first page of the product list (no page number is mapped, so only the first page is read). partial: more rows exist than were read. */
  async products(ctx: Ctx<Settings>): Promise<{ items: Product[]; partial: boolean }> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_Products", summary: "read products (first page)" });
    const rows: any[] = r.data?.Items ?? [];
    return { items: rows.map(toProduct).filter((p: Product | undefined): p is Product => !!p), partial: partialRead(r.data, rows) };
  },
  /** The first page of stock on hand, one row per product per warehouse. partial: totals per product may be incomplete. */
  async stock(ctx: Ctx<Settings>): Promise<{ levels: StockLevel[]; partial: boolean }> {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_StockOnHand", summary: "read stock on hand (first page)" });
    const out: StockLevel[] = [];
    const rows: any[] = r.data?.Items ?? [];
    for (const i of rows) {
      const code = text(i?.ProductCode, 100), qty = num(i?.QtyOnHand);
      if (!CODE.test(code) || qty === undefined) continue;
      out.push({ code, guid: GUID.test(String(i.ProductGuid ?? "")) ? String(i.ProductGuid) : undefined, warehouse: text(i.WarehouseCode, 15) || undefined, qty });
    }
    return { levels: out, partial: partialRead(r.data, rows) };
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
