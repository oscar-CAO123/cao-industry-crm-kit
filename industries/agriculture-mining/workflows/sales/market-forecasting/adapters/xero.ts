// Xero: the sales history (what was invoiced, to whom, at what unit price) and the item list with its sales prices.
// Read only. Nothing here writes to Xero.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Item, type SaleLine, type Settings, GUID, keyOf } from "../types.ts";

const P = "xero";
const PAGE = 100;
const MAX_PAGES = 10;

/** Sales invoices (ACCREC) dated on or after `from` (YYYY-MM-DD), one row per line item. Drafts and voided invoices are skipped. */
export async function sales(ctx: Ctx<Settings>, from: string): Promise<SaleLine[]> {
  const out: SaleLine[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `read sales invoices, page ${page}`,
      input: { params: { where: 'Type=="ACCREC"', order: "Date DESC", page } } });
    const invoices: any[] = Array.isArray(r.data?.Invoices) ? r.data.Invoices : [];
    for (const inv of invoices) {
      if (!["AUTHORISED", "PAID"].includes(String(inv.Status))) continue;
      const id = String(inv.InvoiceID ?? "");
      const date = /^(\d{4}-\d{2}-\d{2})/.exec(String(inv.Date ?? ""))?.[1];
      if (!GUID.test(id) || !date || date < from) continue;
      const buyer = String(inv.Contact?.Name ?? "").slice(0, 120);
      (Array.isArray(inv.LineItems) ? inv.LineItems : []).forEach((l: any, n: number) => {
        const qty = Number(l.Quantity), unit = Number(l.UnitAmount);
        const code = String(l.ItemCode || l.Description || "").slice(0, 60);
        if (!code || !(qty > 0) || !Number.isFinite(unit) || unit < 0) return;
        out.push({ id: keyOf(`xero:${id}:${n}`), date, code, name: String(l.Description ?? code).slice(0, 120), qty, unit, buyer });
      });
    }
    if (invoices.length < PAGE) break;
  }
  return out;
}

/** Items with a sales unit price. The sales price is the list price this workflow compares against invoiced prices. */
export async function items(ctx: Ctx<Settings>): Promise<Item[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getItems", summary: "read item sales prices" });
  return (Array.isArray(r.data?.Items) ? r.data.Items : [])
    .filter((i: any) => i.Code && Number.isFinite(Number(i.SalesDetails?.UnitPrice)))
    .map((i: any): Item => ({ code: String(i.Code).slice(0, 60), name: String(i.Name ?? i.Code).slice(0, 120), price: Number(i.SalesDetails.UnitPrice) }));
}
