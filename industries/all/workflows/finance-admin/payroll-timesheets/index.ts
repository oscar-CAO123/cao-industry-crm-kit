// The payroll-timesheets workflow's three crons. Each reads, drafts internal records, or queues one live act for approval.
// No cron approves a timesheet, posts a pay run or pays anyone: those acts wait in the approval queue for a person.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Mirror, type PayRunRec, type Settings, GUID, clean, keyFor, period } from "./types.ts";
import { approvedShifts } from "./adapters/deputy.ts";
import { addLine, approveAct, createPayRunAct, createTimesheet, getPayRunAct, postPayRunAct, timesheetsIn } from "./adapters/xero.ts";

const DEFAULT_MAX_HOURS = 12;
const HELD_STATES = ["flagged", "needs-check", "creating"];

/** Holds that belong to this pay period. A hold from an earlier period never blocks this one. */
async function holdsIn(ctx: Ctx<Settings>, p: { start: string; end: string }): Promise<Mirror[]> {
  return Object.values(await ctx.store.list<Mirror>("hours"))
    .filter((m) => HELD_STATES.includes(m.state) && !!m.date && m.date >= p.start && m.date <= p.end);
}

/** Every 30 minutes, Deputy only: approved Deputy shifts in the pay period become draft lines on that person's Xero timesheet.
 *  A shift is mirrored once. A shift over the daily limit is held for a person. A shift whose outcome is unclear is marked
 *  needs-check and never retried on its own. */
export async function mirror(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  if (s.timesheets !== "deputy") return { skipped: "hours are captured in Xero" };
  const p = period(s);
  if (!s.earnings_rate_id || !GUID.test(s.earnings_rate_id)) throw new Error("earnings_rate_id must be a Xero earnings rate GUID");
  const max = s.max_hours_per_shift ?? DEFAULT_MAX_HOURS;
  let mirrored = 0, flagged = 0, unmapped = 0, failed = 0;
  // Timesheets still Draft in Xero. A line is never added to one that has been approved since it was made.
  const drafts = new Set((await timesheetsIn(ctx, p, "Draft")).map((t) => t.timesheetID));
  for (const shift of await approvedShifts(ctx)) {
    const key = keyFor("deputy", shift.id);
    if (await ctx.store.get<Mirror>("hours", key)) continue;          // already mirrored, held, or needs a check
    const employee = (s.employee_map ?? {})[shift.employee];
    if (!employee || !GUID.test(employee)) { unmapped++; continue; }    // no Xero employee yet: skipped and counted, nothing written
    const at = ctx.now.toISOString();
    if (shift.hours > max) {
      flagged++;
      await ctx.store.put("hours", key, { state: "flagged", employee, date: shift.date, hours: shift.hours, reason: `${shift.hours} hours in one shift, over ${max}`, at } satisfies Mirror);
      continue;
    }
    await ctx.store.put("hours", key, { state: "creating", employee, date: shift.date, hours: shift.hours, at } satisfies Mirror);
    try {
      const line = { date: shift.date, earningsRateID: s.earnings_rate_id, numberOfUnits: shift.hours };
      const tsKey = keyFor("xts", employee, p.start);
      const existing = await ctx.store.get<string>("xts", tsKey);
      let tsId: string;
      if (existing) {
        if (!drafts.has(existing)) throw new Error("this timesheet is no longer Draft in Xero: check it before more hours go on");
        await addLine(ctx, existing, line, key);
        tsId = existing;
      } else {
        tsId = await createTimesheet(ctx, employee, p, line, key);
        drafts.add(tsId);
        await ctx.store.put("xts", tsKey, tsId);
      }
      await ctx.store.put("hours", key, { state: "mirrored", employee, date: shift.date, hours: shift.hours, xero_timesheet: tsId, at } satisfies Mirror);
      mirrored++;
    } catch (e: any) {
      failed++;
      const reason = clean(e?.message ?? e, 160);
      await ctx.store.put("hours", key, { state: "needs-check", employee, date: shift.date, hours: shift.hours, reason, at } satisfies Mirror);
      ctx.log(`mirror: shift ${shift.id} needs a check in Xero: ${reason}`);
    }
  }
  ctx.log(`mirror: ${mirrored} mirrored, ${flagged} held over the daily limit, ${unmapped} without a Xero employee, ${failed} need a check`);
  return { mirrored, flagged, unmapped, failed };
}

/** Hourly: each Draft timesheet in the pay period with hours is queued for approval, unless one of that person's shifts is held.
 *  Run it once the period's shifts are approved in Deputy. Approval itself is queued, never run here. */
export async function approve(ctx: Ctx<Settings>) {
  const s = ctx.settings, p = period(s);
  // An approved Deputy shift that mirror has not written yet would land on a timesheet after its approval was queued, so nothing is queued until it has.
  if (s.timesheets === "deputy") {
    let unmirrored = 0;
    for (const sh of await approvedShifts(ctx)) {
      const emp = (s.employee_map ?? {})[sh.employee];
      if (!emp || !GUID.test(emp)) continue;   // mirror skips these without storing them
      if (!(await ctx.store.get<Mirror>("hours", keyFor("deputy", sh.id)))) unmirrored++;
    }
    if (unmirrored) { ctx.log(`approve: ${unmirrored} approved shift(s) not mirrored yet, nothing queued`); return { queued: 0, held: 0, waiting: `${unmirrored} approved shift(s) not mirrored yet` }; }
  }
  const holds = new Set((await holdsIn(ctx, p)).map((m) => m.employee));
  let queued = 0, held = 0;
  for (const t of await timesheetsIn(ctx, p, "Draft")) {
    if (!(t.totalHours > 0)) continue;
    if (holds.has(t.employeeID)) { held++; continue; }
    await ctx.queue(approveAct(t.timesheetID), `Approve timesheet for employee ${t.employeeID}: ${t.totalHours} hours, ${p.start} to ${p.end}`);
    queued++;
  }
  ctx.log(`approve: ${queued} queued for approval, ${held} held`);
  return { queued, held };
}

/** Every two hours: once every timesheet in the pay period is approved and nothing is held, a DRAFT pay run is created in Xero
 *  and posting it is queued for the owner, with its net pay shown. Nothing is posted or paid here. */
export async function payRun(ctx: Ctx<Settings>) {
  const s = ctx.settings, p = period(s);
  const key = keyFor("payrun", s.payroll_calendar_id, p.start);
  let rec = await ctx.store.get<PayRunRec>("payruns", key);
  if (rec?.state === "queued") return { queued: rec.approval, already: true };
  if (rec?.state === "creating") { ctx.log("pay-run: a draft creation has no answer yet, check Xero before anything else"); return { needs_check: true }; }
  const holds = (await holdsIn(ctx, p)).length;
  if (holds) return { waiting: `${holds} shift(s) held or unconfirmed` };
  if (!rec) {
    const sheets = await timesheetsIn(ctx, p);
    if (!sheets.length) return { waiting: "no timesheets in the period" };
    const open = sheets.filter((t) => t.status === "Draft").length;
    if (open) return { waiting: `${open} timesheet(s) not yet approved` };
    await ctx.store.put("payruns", key, { state: "creating", at: ctx.now.toISOString() } satisfies PayRunRec);
    const made = await ctx.draft<any>(createPayRunAct(ctx, p));
    const id = String(made.data?.PayRuns?.[0]?.PayRunID ?? "");
    if (!GUID.test(id)) throw new Error("xero: draft pay run was not confirmed");
    rec = { state: "draft", PayRunID: id, at: ctx.now.toISOString() };
    await ctx.store.put("payruns", key, rec);
  }
  const got = await ctx.draft<any>(getPayRunAct(rec.PayRunID!));
  const net = Number(got.data?.PayRuns?.[0]?.NetPay);
  const label = `Post Xero pay run ${p.start} to ${p.end} (pay date ${p.pay})${Number.isFinite(net) ? `, net pay $${net.toFixed(2)}` : ", net pay not read"}. Check the draft in Xero first.`;
  const approval = await ctx.queue(postPayRunAct(rec.PayRunID!, label), label);
  await ctx.store.put("payruns", key, { ...rec, state: "queued", approval, at: ctx.now.toISOString() } satisfies PayRunRec);
  ctx.log(`pay-run: posting queued for approval ${approval}`);
  return { queued: approval };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { mirror, approve, "pay-run": payRun };
