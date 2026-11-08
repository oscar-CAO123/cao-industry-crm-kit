// Xero: the reports and invoices an owner asks about (profit and loss, balance sheet, bank summary, invoices awaiting
// payment). Read only. Every call here is a draft operation, so nothing leaves the business from this adapter.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Figure, type Settings, DAY, day } from "../types.ts";

const P = "xero";
export type XeroSet = "profit-and-loss" | "balance-sheet" | "bank" | "due-invoices";

/** Xero report rows nest: a Section holds Rows, a Row or SummaryRow has Cells (label, value). */
type XeroRow = { Cells?: { Value?: string }[]; Rows?: XeroRow[] };
export function flattenReport(data: any): Figure[] {
  const out: Figure[] = [];
  const walk = (rows: XeroRow[] = []) => {
    for (const r of rows) {
      const c = r.Cells ?? [];
      if (c.length >= 2 && c[0]?.Value) out.push({ label: String(c[0].Value).slice(0, 120), value: String(c[1]?.Value ?? "").slice(0, 40) });
      walk(r.Rows);
    }
  };
  walk(data?.Reports?.[0]?.Rows);
  return out.slice(0, 200);
}

export async function xeroRows(ctx: Ctx<Settings>, which: XeroSet): Promise<Figure[]> {
  const days = ctx.settings.xero?.lookback_days ?? 90;
  const from = day(new Date(ctx.now.getTime() - days * DAY)), to = day(ctx.now);
  if (which === "due-invoices") {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: "read invoices awaiting payment",
      input: { params: { Statuses: "AUTHORISED", where: 'Type=="ACCREC"', order: "DueDate ASC" } } });
    return (r.data?.Invoices ?? []).slice(0, 100).map((i: any): Figure => ({
      label: `${i.Contact?.Name ?? "Customer"} ${i.InvoiceNumber ?? ""} due ${i.DueDateString ?? ""}`.slice(0, 120),
      value: String(i.AmountDue ?? ""),
    }));
  }
  const op = which === "profit-and-loss" ? "accounting.getReportProfitAndLoss"
    : which === "balance-sheet" ? "accounting.getReportBalanceSheet" : "accounting.getReportBankSummary";
  const params = which === "balance-sheet" ? { date: to } : { fromDate: from, toDate: to };
  const r = await ctx.draft<any>({ platform: P, op, summary: `read ${which}`, input: { params } });
  return flattenReport(r.data);
}
