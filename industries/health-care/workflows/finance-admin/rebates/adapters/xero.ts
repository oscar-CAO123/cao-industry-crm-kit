// Xero: payments against invoices. Reads only. Field names come from the Xero accounting spec
// (accounting): a Payment carries Invoice.InvoiceNumber, Amount, Date and Status.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { PaymentRow, Settings } from "../types.ts";

const P = "xero";

/** Up to maxPages of 100 payments. Stops early when a page comes back short. */
export async function payments(ctx: Ctx<Settings>, maxPages = 10): Promise<PaymentRow[]> {
  const out: PaymentRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getPayments", summary: `payments page ${page}`, input: { params: { page, pageSize: 100 } } });
    const rows: any[] = Array.isArray(r.data?.Payments) ? r.data.Payments : [];
    for (const p of rows) {
      out.push({
        invoice_number: String(p.Invoice?.InvoiceNumber ?? p.InvoiceNumber ?? ""),
        amount: Number(p.Amount ?? 0),
        date: String(p.Date ?? ""),
        status: String(p.Status ?? ""),
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}
