// Xero Payroll AU: a person's timesheet for the pay period, its draft lines, and approving it. Reading timesheets and creating
// draft timesheets and lines are draft operations. Approving a timesheet moves pay, so it is only ever returned as an act to queue.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type XeroTimesheet, guid, keyFor } from "../types.ts";

const P = "xero";
const PAGE_LIMIT = 50;

/** One day's hours on a timesheet at the ordinary earnings rate. */
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

/** A new draft timesheet for one person in the pay period, with its first line. Keyed on the ServiceM8 shift it came from. */
export async function createTimesheet(ctx: Ctx<Settings>, employee: string, p: { start: string; end: string }, line: Line, shiftKey: string): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "payroll-au-v2.createTimesheet", summary: `create draft timesheet for ${employee}`,
    input: { params: { "Idempotency-Key": keyFor("ts", shiftKey) }, body: {
      payrollCalendarID: ctx.settings.payroll_calendar_id, employeeID: employee, startDate: p.start, endDate: p.end, timesheetLines: [line],
    } } });
  return guid(r.data?.timesheet?.timesheetID, "xero timesheet");
}

/** One more line on a draft timesheet. Keyed on the ServiceM8 shift, so a retried run adds it once. */
export async function addLine(ctx: Ctx<Settings>, timesheetId: string, line: Line, shiftKey: string): Promise<void> {
  await ctx.draft({ platform: P, op: "payroll-au-v2.createTimesheetLine", summary: `add line to draft timesheet ${timesheetId}`,
    input: { params: { TimesheetID: guid(timesheetId, "xero timesheet"), "Idempotency-Key": keyFor("line", shiftKey) }, body: line } });
}

/** Approving a timesheet changes what gets paid: it is only ever queued for a person. The approval re-reads the timesheet first and is
 *  closed unless it is still a Draft with the hours the cron saw. The key carries those hours, so a timesheet closed by that check is
 *  queued again once its hours change, and an unchanged one is never queued twice. */
export function approveAct(t: XeroTimesheet): Act {
  const id = guid(t.timesheetID, "xero timesheet");
  return { platform: P, op: "payroll-au-v2.approveTimesheet", key: keyFor("approve", id, String(t.totalHours)),
    summary: `approve timesheet ${id}`, input: { params: { TimesheetID: id } },
    check: { platform: P, op: "payroll-au-v2.getTimesheet", input: { params: { TimesheetID: id } },
      expect: [{ path: "timesheet.status", equals: "Draft" }, { path: "timesheet.totalHours", equals: t.totalHours }] } };
}
