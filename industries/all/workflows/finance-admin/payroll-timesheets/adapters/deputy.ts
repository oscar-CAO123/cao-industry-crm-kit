// Deputy: the shifts staff worked. Reading approved, kept timesheets for a pay period is a draft (read) operation.
// Deputy's own approval is the first check: only shifts a supervisor has approved are read here.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Shift, clean } from "../types.ts";

const P = "deputy";
const PAGE = 500;   // Deputy's resource query returns at most 500 records a page

/** Approved, kept, finished shifts dated in the pay period. Each one is read once per run; the crons keep their own record. */
export async function approvedShifts(ctx: Ctx<Settings>): Promise<Shift[]> {
  const { start, end } = ctx.settings.pay_period;
  const out: Shift[] = [];
  for (let page = 0; page < 50; page++) {
    const r = await ctx.draft<any[]>({ platform: P, op: "deputy-v1-resource-api.searchTimesheet", summary: `read approved shifts, page ${page + 1}`,
      input: { body: { search: {
        s1: { field: "Date", type: "ge", data: start },
        s2: { field: "Date", type: "le", data: end },
        s3: { field: "TimeApproved", type: "eq", data: true },
        s4: { field: "Discarded", type: "eq", data: false },
        s5: { field: "IsInProgress", type: "eq", data: false },
      }, start: page * PAGE, max: PAGE } } });
    const rows = Array.isArray(r.data) ? r.data : [];
    for (const t of rows) {
      const id = String(t.Id ?? ""), employee = String(t.Employee ?? ""), date = String(t.Date ?? "").slice(0, 10);
      const hours = Number(t.TotalTime);
      // Read defensively: a row the query let through that is not approved, kept and finished is skipped.
      if (t.TimeApproved !== true || t.Discarded === true || t.IsInProgress === true) continue;
      if (!/^\d{1,20}$/.test(id) || !/^\d{1,20}$/.test(employee) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!Number.isFinite(hours) || hours <= 0) continue;
      if (date < start || date > end) continue;   // the query filters by date too; a row outside the period is never used
      out.push({ id, employee: clean(employee, 20), date, hours });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}
