// Xero for the commission workflow: paid sales invoices, and the monthly DRAFT pay run with commission on each payslip.
// Reads and draft writes only. A pay run is created as DRAFT and payslips are edited only while it is DRAFT. Posting a
// pay run is a live operation: index.ts builds it and queues it for a person.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Period, GUID, guid, money2 } from "../types.ts";

const P = "xero";
export interface Sale { id: string; ex_gst: number; reference: string }
export interface RunSlip { PayslipID: string; EmployeeID: string }
export interface Run { id: string; status: string; slips: RunSlip[] }

/** Xero's where-clause date: "2026-10-01" becomes DateTime(2026,10,01). Only our own period dates reach it. */
const xeroDate = (s: string) => `DateTime(${s.replace(/-/g, ",")})`;

/** Paid sales invoices dated in the period, ex GST. Xero pages at 100; a short page ends the read. */
export async function paidSales(ctx: Ctx<Settings>, p: Period): Promise<Sale[]> {
  const out: Sale[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `paid sales ${p.period}, page ${page}`,
      input: { params: { where: `Date >= ${xeroDate(p.start)} AND Date <= ${xeroDate(p.end)}`, Statuses: "PAID", page, pageSize: 100 } } });
    const rows: any[] = r.data?.Invoices ?? [];
    for (const i of rows) {
      if (i.Status !== "PAID" || (i.Type && i.Type !== "ACCREC")) continue;
      if (!GUID.test(String(i.InvoiceID ?? ""))) continue;
      const ex = Number(i.SubTotal);
      if (!Number.isFinite(ex)) continue;
      out.push({ id: String(i.InvoiceID), ex_gst: ex, reference: String(i.Reference ?? "").slice(0, 255) });
    }
    if (rows.length < 100) break;
  }
  return out;
}

/** The pay run for the period. Returns the DRAFT one, creates one when `create` is set and none exists, or null when the
 *  period's run is already posted (nothing more can be entered). */
export async function payRunFor(ctx: Ctx<Settings>, p: Period, create: boolean): Promise<Run | null> {
  const list = await ctx.draft<any>({ platform: P, op: "payroll-au.getPayRuns", summary: `pay runs for ${p.period}`, input: {} });
  const hit = (list.data?.PayRuns ?? []).find((r: any) => String(r.PayrollCalendarID ?? "").toLowerCase() === ctx.settings.payroll_calendar_id.toLowerCase()
    && String(r.PayRunPeriodStartDate ?? "").slice(0, 10) === p.start && String(r.PayRunPeriodEndDate ?? "").slice(0, 10) === p.end);
  if (hit && hit.PayRunStatus !== "DRAFT") return null;
  let id: string;
  if (hit) id = guid(hit.PayRunID);
  else {
    if (!create) return null;
    const made = await ctx.draft<any>({ platform: P, op: "payroll-au.createPayRun", summary: `draft pay run for ${p.period}`,
      input: { params: { "Idempotency-Key": `payrun:${p.period}:${ctx.settings.payroll_calendar_id}` },
               body: [{ PayrollCalendarID: ctx.settings.payroll_calendar_id, PayRunPeriodStartDate: p.start, PayRunPeriodEndDate: p.end }] } });
    id = guid(made.data?.PayRuns?.[0]?.PayRunID);
  }
  const one = await ctx.draft<any>({ platform: P, op: "payroll-au.getPayRun", summary: `read pay run ${p.period}`, input: { params: { PayRunID: id } } });
  const run = one.data?.PayRuns?.[0] ?? {};
  const slips: RunSlip[] = (run.Payslips ?? []).map((s: any) => ({ PayslipID: guid(s.PayslipID), EmployeeID: String(s.EmployeeID ?? "").toLowerCase() }));
  return { id, status: String(run.PayRunStatus ?? ""), slips };
}

/** Set the commission line on one payslip. The other earnings lines are kept, so a repeat writes the same result. */
export async function enterOnPayslip(ctx: Ctx<Settings>, slipId: string, amount: number): Promise<void> {
  const id = guid(slipId), rate = guid(ctx.settings.commission_earnings_rate_id);
  const cur = await ctx.draft<any>({ platform: P, op: "payroll-au.getPayslip", summary: "read payslip", input: { params: { PayslipID: id } } });
  const lines: any[] = (cur.data?.Payslip?.EarningsLines ?? []).filter((l: any) => String(l.EarningsRateID ?? "").toLowerCase() !== rate.toLowerCase());
  lines.push({ EarningsRateID: rate, CalculationType: "ENTEREARNINGSRATE", NumberOfUnits: 1, RatePerUnit: money2(amount) });
  await ctx.draft({ platform: P, op: "payroll-au.updatePayslip", summary: `commission ${money2(amount)} on payslip`,
    input: { params: { PayslipID: id }, body: [{ EarningsLines: lines }] } });
}
