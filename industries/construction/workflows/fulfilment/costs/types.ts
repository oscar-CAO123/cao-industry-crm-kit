// Shared shapes for the costs workflow. The only platform with mapped operations for this job is Xero.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export interface Settings {
  family: "job-cost-tracking";
  budget_from: string;                 // YYYY-MM-DD, first day of the budget period
  budget_to: string;                   // YYYY-MM-DD, last day of the budget period
  overrun_tolerance_percent?: number;  // flag only when exposure is more than this percent over budget (default 0)
  business_name?: string;
}

/** One budget line: the budgeted amount for one account code in the period. */
export interface BudgetRow { key: string; budget_id: string; budget_name: string; account_code: string; budget: number; checked: string }

/** One account code checked against the period: committed (open purchase orders) plus actual (bills) against budget. */
export interface SpendRow {
  key: string; account_code: string; budget: number; committed: number; actual: number;
  exposure: number; over_by: number; flagged: boolean; checked: string;
}

export interface Timesheet { timesheetID: string; employeeID?: string; startDate: string; endDate: string; totalHours: number }

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkSettings(s: Settings): void {
  if (s.family !== "job-cost-tracking") throw new Error("costs: family must be job-cost-tracking");
  if (!DATE.test(s.budget_from) || !DATE.test(s.budget_to) || Number.isNaN(Date.parse(s.budget_from)) || Number.isNaN(Date.parse(s.budget_to))
      || new Date(s.budget_from).toISOString().slice(0, 10) !== s.budget_from || new Date(s.budget_to).toISOString().slice(0, 10) !== s.budget_to
      || s.budget_from > s.budget_to) throw new Error("costs: budget_from and budget_to must be real YYYY-MM-DD dates, from before to");
  const t = s.overrun_tolerance_percent ?? 0;
  if (!(t >= 0 && t <= 100)) throw new Error("costs: overrun_tolerance_percent must be between 0 and 100");
}

export const round = (n: number) => Math.round(n * 100) / 100;
