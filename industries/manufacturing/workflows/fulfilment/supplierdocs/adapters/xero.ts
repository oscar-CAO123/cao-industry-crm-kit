// Xero for supplier bills: a bill arrives as a DRAFT purchase bill (ACCPAY), the item list is the SKU list (Item Code),
// and authorising a bill is the one live step. Field names are from Xero's official accounting spec.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Doc, type Item, type Settings, clip, guid, num } from "../types.ts";

const P = "xero";
const PAGE = 100, MAX_PAGES = 5;   // Xero returns 100 bills a page; a run reads at most 500, the next run takes the rest

export const xero = {
  id: P,
  /** Draft purchase bills, read page by page. Only ACCPAY bills in DRAFT become documents. */
  async bills(ctx: Ctx<Settings>): Promise<Doc[]> {
    const out: Doc[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `read draft supplier bills, page ${page}`,
        input: { params: { where: 'Type=="ACCPAY" AND Status=="DRAFT"', page } } });
      const rows: any[] = r.data?.Invoices ?? [];
      for (const i of rows) {
        if (i.Type !== "ACCPAY" || i.Status !== "DRAFT") continue;
        if (!/^[0-9a-f-]{36}$/i.test(String(i.InvoiceID ?? ""))) continue;
        out.push({
          id: guid(i.InvoiceID), number: clip(i.InvoiceNumber, 60), supplier: clip(i.Contact?.Name, 120), date: clip(i.Date, 40),
          total: num(i.Total), status: "new", reasons: [], seen: ctx.now.toISOString(),
          lines: (i.LineItems ?? []).slice(0, 200).map((l: any) => ({
            description: clip(l.Description, 300), code: clip(l.ItemCode, 60), qty: num(l.Quantity, 1e6), unit: num(l.UnitAmount, 1e9),
          })),
        });
      }
      if (rows.length < PAGE) break;
    }
    return out;
  },
  /** The SKU list: every Xero item with a code, and its purchase price. */
  async items(ctx: Ctx<Settings>): Promise<Item[]> {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getItems", summary: "read Xero items (SKU list)" });
    return (r.data?.Items ?? []).filter((i: any) => i.Code)
      .map((i: any): Item => ({ code: clip(i.Code, 60), name: clip(i.Name ?? i.Code, 120), cost: num(i.PurchaseDetails?.UnitPrice) }));
  },
  /** The live step: authorise one bill. Queued by the publish cron, run only when a person approves it. */
  authoriseAct(d: Doc): Act {
    const id = guid(d.id);
    return { platform: P, op: "accounting.updateInvoice", key: `authorise:${id}`, summary: `authorise bill ${d.number || id} in Xero`,
      input: { params: { InvoiceID: id, "Idempotency-Key": safeKey(`authorise:${id}`, 120) },
               body: { Invoices: [{ InvoiceID: id, Status: "AUTHORISED" }] } } };
  },
};
