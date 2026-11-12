// Cliniko: the practice system that holds the invoices and their items. Reads only: nothing here changes a record.
// Field names come from the vendor's API reference (the invoice and invoice-item pages):
// invoices list under "invoices", items under "invoice_items"; invoice status is a number (10 Open, 20 Paid, 30 Closed, 40 Open credit).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { InvoiceRow, Settings } from "../types.ts";

const P = "cliniko";
const ID = /^\d{1,18}$/;
export const clinikoId = (v: unknown) => { const s = String(v ?? ""); if (!ID.test(s)) throw new Error("cliniko: bad id"); return s; };

/** Up to maxPages of 100 invoices. Stops early when a page comes back short. */
export async function listInvoices(ctx: Ctx<Settings>, maxPages = 10): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "invoice.listinvoices", summary: `invoices page ${page}`, input: { params: { per_page: 100, page } } });
    const rows: any[] = Array.isArray(r.data?.invoices) ? r.data.invoices : [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

export async function invoiceItems(ctx: Ctx<Settings>, invoiceId: string): Promise<any[]> {
  const r = await ctx.draft<any>({ platform: P, op: "invoice-item.listinvoiceitemsforinvoice", summary: `items of invoice ${invoiceId}`,
    input: { params: { invoice_id: clinikoId(invoiceId), per_page: 100 } } });
  return Array.isArray(r.data?.invoice_items) ? r.data.invoice_items : [];
}

/** Keep only what the finder needs from an invoice and its items. */
export function toRow(inv: any, items: any[]): InvoiceRow {
  const id = clinikoId(inv.id);
  return {
    key: `cliniko:${id}`,
    id,
    number: Number(inv.number) || 0,
    status: Number(inv.status) || 0,
    total_amount: String(inv.total_amount ?? "0"),
    created_at: String(inv.created_at ?? ""),
    codes: items.map((i) => String(i.code ?? "")).filter(Boolean).slice(0, 50),
  };
}
