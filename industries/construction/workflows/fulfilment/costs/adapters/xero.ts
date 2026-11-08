// Xero: the budget, the committed and actual cost of the period, and the timesheets waiting for approval.
// Reads are draft operations. Approving a timesheet moves wages, so it is only ever queued for a person.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import type { Act } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type BudgetRow, type Timesheet, GUID, round } from "../types.ts";

const P = "xero";
const MAX_PAGES = 20;   // a hard stop on paging, so a bad response cannot loop forever
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });

const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
/** A Xero amount must be a number. A missing one is an error, never a silent zero that would hide spend. */
const amount = (v: unknown) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error("xero: non-numeric amount"); return n; };

/** Budgeted amounts (UnitAmount) for each account code in the period. Budgets are read by id, with the period filter. */
export async function readBudgets(ctx: Ctx<Settings>): Promise<BudgetRow[]> {
  const s = ctx.settings;
  const list = await ctx.draft<any>({ platform: P, op: "accounting.getBudgets", summary: "list budgets" });
  const out: BudgetRow[] = [];
  for (const b of (list.data?.Budgets ?? []).slice(0, 50)) {
    const id = guid(b.BudgetID);
    const one = await ctx.draft<any>({ platform: P, op: "accounting.getBudget", summary: `budget ${id.slice(0, 8)} for the period`,
      input: { params: { BudgetID: id, DateFrom: s.budget_from, DateTo: s.budget_to } } });
    const full = one.data?.Budgets?.[0] ?? {};
    for (const line of full.BudgetLines ?? []) {
      const code = String(line.AccountCode ?? "");
      if (!code) continue;
      const budget = (line.BudgetBalances ?? []).reduce((a: number, x: any) => a + amount(x.UnitAmount ?? 0), 0);
      out.push({ key: safeKey(`${id}:${code}`), budget_id: id, budget_name: String(full.Description ?? "").slice(0, 120),
                 account_code: code.slice(0, 40), budget: round(budget), checked: ctx.now.toISOString() });
    }
  }
  return out;
}

/** Walk one paged list. The rows are read as data; nothing in them is run or sent. */
async function pages(ctx: Ctx<Settings>, op: string, base: Record<string, unknown>, key: "PurchaseOrders" | "Invoices"): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op, summary: `${op} page ${page}`, input: { params: { ...base, page } } });
    const rows: any[] = r.data?.[key] ?? [];
    if (!rows.length) break;
    out.push(...rows);
  }
  return out;
}

/** Bills dated in the period. The dates are checked digits, so the filter text cannot be changed by the data. */
const billsWhere = (s: Settings) => {
  const [y1, m1, d1] = s.budget_from.split("-").map(Number), [y2, m2, d2] = s.budget_to.split("-").map(Number);
  return `Type=="ACCPAY" AND Date >= DateTime(${y1}, ${m1}, ${d1}) AND Date <= DateTime(${y2}, ${m2}, ${d2})`;
};

/** Committed (purchase orders not yet billed) and actual (bills not draft or void) per account code in the period. */
export async function readSpend(ctx: Ctx<Settings>): Promise<Map<string, { committed: number; actual: number }>> {
  const s = ctx.settings;
  const out = new Map<string, { committed: number; actual: number }>();
  const add = (code: string, k: "committed" | "actual", amt: number) => {
    if (!code) return;
    const cur = out.get(code) ?? { committed: 0, actual: 0 };
    cur[k] += amt;
    out.set(code, cur);
  };
  const pos = await pages(ctx, "accounting.getPurchaseOrders", { DateFrom: s.budget_from, DateTo: s.budget_to }, "PurchaseOrders");
  for (const po of pos) {
    if (!["SUBMITTED", "AUTHORISED"].includes(po.Status)) continue;   // a BILLED order is counted by its bill
    for (const li of po.LineItems ?? []) add(String(li.AccountCode ?? ""), "committed", amount(li.LineAmount));
  }
  const bills = await pages(ctx, "accounting.getInvoices", { where: billsWhere(s) }, "Invoices");
  for (const inv of bills) {
    if (!["AUTHORISED", "PAID"].includes(inv.Status)) continue;
    for (const li of inv.LineItems ?? []) add(String(li.AccountCode ?? ""), "actual", amount(li.LineAmount));
  }
  for (const v of out.values()) { v.committed = round(v.committed); v.actual = round(v.actual); }
  return out;
}

/** Timesheets still in Draft in Xero payroll. */
export async function draftTimesheets(ctx: Ctx<Settings>): Promise<Timesheet[]> {
  const r = await ctx.draft<any>({ platform: P, op: "payroll-au-v2.getTimesheets", summary: "draft timesheets", input: { params: { status: "Draft" } } });
  return (r.data?.timesheets ?? []).map((t: any): Timesheet => ({
    timesheetID: guid(t.timesheetID), employeeID: t.employeeID ? guid(t.employeeID) : undefined,
    startDate: String(t.startDate ?? "").slice(0, 10), endDate: String(t.endDate ?? "").slice(0, 10), totalHours: amount(t.totalHours ?? 0),
  }));
}

/** The approval for one timesheet. It is only ever queued: a person approves it in the CRM shell. */
export const approveTimesheetAct = (t: Timesheet): Act => ({
  platform: P, op: "payroll-au-v2.approveTimesheet",
  input: { params: { TimesheetID: t.timesheetID, ...idem(`timesheet:${t.timesheetID}`) } },
  summary: `approve timesheet ${t.timesheetID.slice(0, 8)} (${t.totalHours} hours, ${t.startDate} to ${t.endDate})`,
  key: `timesheet:${t.timesheetID}`,
});
