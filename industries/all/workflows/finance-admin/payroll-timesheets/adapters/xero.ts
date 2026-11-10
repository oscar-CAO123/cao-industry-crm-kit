// Xero Payroll AU: the timesheets for each person in a pay period, the draft pay run, and posting it.
// Reading timesheets, creating draft timesheets and lines, and creating a DRAFT pay run are draft operations.
// Approving a timesheet and posting a pay run move pay, so they are only ever returned as acts to queue for a person.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type XeroTimesheet, clean, guid, keyFor, xeroDate } from "../types.ts";

const P = "xero";
const PAGE_LIMIT = 50;

/** One line of a timesheet: a day's hours at the ordinary earnings rate. */
export interface Line { date: string; earningsRateID: string; numberOfUnits: number }

/** Every timesheet in the pay period, optionally only one status. Pages until Xero says there are no more. */
export async function timesheetsIn(ctx: Ctx<Settings>, p: { start: string; end: string }, status?: XeroTimesheet["status"]): Promise<XeroTimesheet[]> {
  const out: XeroTimesheet[] = [];
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, PAGE_LIMIT); page++) {
    const r = await ctx.draft<any>({ platform: P, op: "payroll-au-v2.getTimesheets", summary: `read timesheets, page ${page}`,
      input: { params: { page, startDate: p.start, endDate: p.end, ...(status ? { status } : {}) } } });
    pages = Number(r.data?.pagination?.pageCount) || 1;
    for (const t of r.data?.timesheets ?? []) {
      const id = String(t.timesheetID ?? ""), employee = String(t.employeeID ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(employee)) continue;
      out.push({ timesheetID: id, employeeID: employee, status: t.status, totalHours: Number(t.totalHours) || 0 });
    }
  }
  return out;
}

/** A new draft timesheet for one person in the pay period, with its first line. Keyed on the Deputy shift it came from. */
export async function createTimesheet(ctx: Ctx<Settings>, employee: string, p: { start: string; end: string }, line: Line, shiftKey: string): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "payroll-au-v2.createTimesheet", summary: `create draft timesheet for ${employee}`,
    input: { params: { "Idempotency-Key": safeKey(`ts:${shiftKey}`, 120) }, body: {
      payrollCalendarID: ctx.settings.payroll_calendar_id, employeeID: employee, startDate: p.start, endDate: p.end, timesheetLines: [line],
    } } });
  return guid(r.data?.timesheet?.timesheetID, "xero timesheet");
}

/** One more line on a draft timesheet. Keyed on the Deputy shift, so a retried run adds it once. */
export async function addLine(ctx: Ctx<Settings>, timesheetId: string, line: Line, shiftKey: string): Promise<void> {
  await ctx.draft({ platform: P, op: "payroll-au-v2.createTimesheetLine", summary: `add line to draft timesheet ${timesheetId}`,
    input: { params: { TimesheetID: guid(timesheetId, "xero timesheet"), "Idempotency-Key": safeKey(`line:${shiftKey}`, 120) }, body: line } });
}

/** Approving a timesheet changes what gets paid: it is only ever queued. */
export function approveAct(timesheetId: string): Act {
  return { platform: P, op: "payroll-au-v2.approveTimesheet", key: keyFor("approve", timesheetId),
    summary: `approve timesheet ${timesheetId}`, input: { params: { TimesheetID: guid(timesheetId, "xero timesheet") } } };
}

/** A DRAFT pay run for the calendar and period. Xero keeps it unpaid until it is posted. */
export function createPayRunAct(ctx: Ctx<Settings>, p: { start: string; end: string; pay: string }): Act {
  return { platform: P, op: "payroll-au.createPayRun", summary: `create draft pay run ${p.start} to ${p.end}`,
    input: { params: { "Idempotency-Key": safeKey(`payrun:${ctx.settings.payroll_calendar_id}:${p.start}`, 120) }, body: [{
      PayrollCalendarID: ctx.settings.payroll_calendar_id, PayRunPeriodStartDate: xeroDate(p.start), PayRunPeriodEndDate: xeroDate(p.end),
      PaymentDate: xeroDate(p.pay), PayRunStatus: "DRAFT",
    }] } };
}

/** Read one pay run back, so the approval shows its real net pay. */
export function getPayRunAct(payRunId: string): Act {
  return { platform: P, op: "payroll-au.getPayRun", summary: "read draft pay run", input: { params: { PayRunID: guid(payRunId, "xero pay run") } } };
}

/** Posting a pay run is what makes it ready for payment: it is only ever queued. */
export function postPayRunAct(payRunId: string, label: string): Act {
  return { platform: P, op: "payroll-au.updatePayRun", key: keyFor("post", payRunId),
    summary: clean(label, 300), input: { params: { PayRunID: guid(payRunId, "xero pay run") }, body: [{ PayRunStatus: "POSTED" }] } };
}
