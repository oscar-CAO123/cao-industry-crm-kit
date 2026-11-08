// Xero: fuel bills in the BAS period. Read only. Field names are from the Xero accounting OpenAPI spec
// (Invoice: Type, Date, InvoiceID, Contact.Name, LineItems[].Description, AccountCode, LineAmount).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Bill, type Settings, DAY, GUID, money } from "../types.ts";

const dateExpr = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `DateTime(${y},${m},${d})`; };

/** Fuel lines on purchase bills (ACCPAY) dated inside the period. Only the first page is read (100 bills). */
export async function fuelBills(ctx: Ctx<Settings>): Promise<{ bills: Bill[]; pageFull: boolean }> {
  const { period_start: start, period_end: end } = ctx.settings;
  if (!DAY.test(start) || !DAY.test(end)) throw new Error("fuel-tax-credits: period dates must be YYYY-MM-DD");
  const words = (ctx.settings.fuel_keywords ?? ["fuel", "diesel", "petrol", "unleaded"]).map((w) => w.toLowerCase());
  const where = `Type=="ACCPAY" AND Date>=${dateExpr(start)} AND Date<=${dateExpr(end)}`;
  const r = await ctx.draft<any>({ platform: "xero", op: "accounting.getInvoices", summary: `fuel bills ${start} to ${end}`,
    input: { params: { where, Statuses: "AUTHORISED,PAID" } } }); // Xero takes comma-separated statuses; the SDK would JSON-encode an array
  const invoices: any[] = Array.isArray(r.data?.Invoices) ? r.data.Invoices : [];
  const bills: Bill[] = [];
  for (const inv of invoices) {
    const id = String(inv.InvoiceID ?? "");
    if (!GUID.test(id)) continue;
    const date = String(inv.Date ?? "").slice(0, 10);
    if (!DAY.test(date)) continue;
    (inv.LineItems ?? []).forEach((li: any, i: number) => {
      const description = String(li.Description ?? "").slice(0, 200);
      const code = String(li.AccountCode ?? "");
      const hay = `${description} ${code}`.toLowerCase();
      if (!words.some((w) => hay.includes(w))) return;
      bills.push({ id: `${id}:${i}`, invoice_id: id, date, supplier: String(inv.Contact?.Name ?? "").slice(0, 120) || undefined,
        description, account_code: code || undefined, amount_ex_gst: money(Number(li.LineAmount ?? 0)) });
    });
  }
  return { bills, pageFull: invoices.length >= 100 };
}
