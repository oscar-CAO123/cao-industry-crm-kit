// Xero: the profit and loss and the bank summary, read through the Reports API. Reads only.
// Response shape (ReportWithRows, Xero OpenAPI xero_accounting): Reports[0].Rows[] of { RowType, Title, Cells[].Value, Rows[] }.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Period, type Row, str } from "../types.ts";

const P = "xero";
interface Cell { Value?: unknown }
interface RawRow { RowType?: unknown; Title?: unknown; Cells?: Cell[]; Rows?: RawRow[] }
interface Report { Reports?: { Rows?: RawRow[] }[] }
const MAX_ROWS = 500;

/** Walk the report's rows and keep the header's column titles and every line in order. */
function parse(data: Report): { columns: string[]; rows: Row[] } {
  const report = data?.Reports?.[0];
  if (!report || !Array.isArray(report.Rows)) throw new Error("xero: the report came back without rows");
  let columns: string[] = [];
  const rows: Row[] = [];
  const walk = (list: RawRow[]) => {
    for (const r of list) {
      if (rows.length >= MAX_ROWS) return;
      const type = str(r.RowType, 40);
      const cells = Array.isArray(r.Cells) ? r.Cells.map((c) => str(c?.Value, 200)) : [];
      if (type === "Header") columns = cells;
      else if (type === "Section") rows.push({ label: str(r.Title), values: [], type });
      else if ((type === "Row" || type === "SummaryRow") && cells.length) rows.push({ label: cells[0], values: cells.slice(1), type });
      if (Array.isArray(r.Rows)) walk(r.Rows);
    }
  };
  walk(report.Rows);
  return { columns, rows };
}

/** Profit and loss for the period. */
export async function profitAndLoss(ctx: Ctx<Settings>, p: Period) {
  const r = await ctx.draft<Report>({ platform: P, op: "accounting.getReportProfitAndLoss", summary: `profit and loss ${p.start} to ${p.end}`,
    input: { params: { fromDate: p.start, toDate: p.end } } });
  return parse(r.data);
}

/** Bank summary for the period: money in, money out and the closing balance per bank account. */
export async function bankSummary(ctx: Ctx<Settings>, p: Period) {
  const r = await ctx.draft<Report>({ platform: P, op: "accounting.getReportBankSummary", summary: `bank summary ${p.start} to ${p.end}`,
    input: { params: { fromDate: p.start, toDate: p.end } } });
  return parse(r.data);
}
