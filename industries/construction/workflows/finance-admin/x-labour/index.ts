// The labour-by-person workflow's two crons. Each reads ServiceM8 clock events, drafts Xero timesheet lines, or queues one
// approval for a person. No cron approves a timesheet or pays anyone.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Holds, type Settings, type ShiftRec, GUID, clean, keyFor, period } from "./types.ts";
import { shiftsFrom, staffEvents } from "./adapters/servicem8.ts";
import { addLine, approveAct, createTimesheet, timesheetsIn } from "./adapters/xero.ts";

const DEFAULT_MAX_HOURS = 12;

/** Every 30 minutes: ServiceM8 clock events for the pay period become draft lines on each person's Xero timesheet.
 *  A complete shift is written once. A shift over the daily limit is held. A person whose clock events do not pair, or who is
 *  still clocked on, is held from approval. A write with an unclear outcome is marked needs-check and never retried on its own. */
export async function mirror(ctx: Ctx<Settings>) {
  const s = ctx.settings, p = period(s);
  if (!GUID.test(String(s.earnings_rate_id ?? ""))) throw new Error("earnings_rate_id must be a Xero earnings rate GUID");
  const max = s.max_hours_per_shift ?? DEFAULT_MAX_HOURS;
  const at = ctx.now.toISOString();
  const holdKey = keyFor("period", p.start);
  const { events, bad } = await staffEvents(ctx, p);
  if (bad) {
    // A clock row that does not check out means nothing can be trusted for this period: everyone mapped is held until a person checks.
    await ctx.store.put("holds", holdKey, { employees: Object.values(s.employee_map ?? {}).filter((g) => GUID.test(g)), at } satisfies Holds);
    ctx.log(`mirror: ${bad} clock row(s) did not check out, so every mapped person is held`);
    return { blocked: bad };
  }
  const { shifts, open, problem } = shiftsFrom(events);
  let mirrored = 0, flagged = 0, unmapped = 0, failed = 0;
  for (const sh of shifts) {
    const rk = keyFor("shift", sh.key);
    const prior = await ctx.store.get<ShiftRec>("shifts", rk);
    if (prior) {
      if (prior.state === "creating") await ctx.store.put("shifts", rk, { ...prior, state: "needs-check", reason: "no answer from an earlier write", at } satisfies ShiftRec);
      continue;
    }
    const employee = (s.employee_map ?? {})[sh.staff];
    if (!employee || !GUID.test(employee)) { unmapped++; continue; }
    const base = { period: p.start, staff: sh.staff, date: sh.date, hours: sh.hours, at };
    if (sh.hours > max) {
      flagged++;
      await ctx.store.put("shifts", rk, { ...base, state: "flagged", reason: `${sh.hours} hours in one shift, over ${max}` } satisfies ShiftRec);
      continue;
    }
    await ctx.store.put("shifts", rk, { ...base, state: "creating" } satisfies ShiftRec);
    try {
      const line = { date: sh.date, earningsRateID: s.earnings_rate_id, numberOfUnits: sh.hours };
      const tsKey = keyFor("xts", employee, p.start);
      const existing = await ctx.store.get<string>("xts", tsKey);
      let tsId: string;
      if (existing) {
        await addLine(ctx, existing, line, sh.key);
        tsId = existing;
      } else {
        tsId = await createTimesheet(ctx, employee, p, line, sh.key);
        await ctx.store.put("xts", tsKey, tsId);
      }
      await ctx.store.put("shifts", rk, { ...base, state: "mirrored", xero_timesheet: tsId } satisfies ShiftRec);
      mirrored++;
    } catch (e: any) {
      failed++;
      const reason = clean(e?.message ?? e, 160);
      await ctx.store.put("shifts", rk, { ...base, state: "needs-check", reason } satisfies ShiftRec);
      ctx.log(`mirror: shift ${sh.key} needs a check in Xero: ${reason}`);
    }
  }
  // Held from approval: anyone still clocked on, with a clock problem, or with a shift that is flagged, creating or needs a check.
  const held = new Set<string>([...open, ...problem]);
  for (const r of Object.values(await ctx.store.list<ShiftRec>("shifts"))) if (r.period === p.start && r.state !== "mirrored") held.add(r.staff);
  const employees = [...held].map((st) => s.employee_map?.[st]).filter((g): g is string => !!g && GUID.test(g));
  await ctx.store.put("holds", holdKey, { employees, at } satisfies Holds);
  ctx.log(`mirror: ${mirrored} mirrored, ${flagged} held over the daily limit, ${unmapped} without a Xero employee, ${failed} need a check, ${employees.length} held`);
  return { mirrored, flagged, unmapped, failed, held: employees.length };
}

/** Hourly: each Draft timesheet with hours is queued for approval, unless its person is held. Runs only once mirror has run for the period.
 *  Approval itself is queued, never run here. */
export async function approve(ctx: Ctx<Settings>) {
  const p = period(ctx.settings);
  const holds = await ctx.store.get<Holds>("holds", keyFor("period", p.start));
  if (!holds) return { waiting: "mirror has not run for this period" };
  const heldSet = new Set(holds.employees);
  let queued = 0, heldCount = 0;
  for (const t of await timesheetsIn(ctx, p, "Draft")) {
    if (!(t.totalHours > 0)) continue;
    if (heldSet.has(t.employeeID)) { heldCount++; continue; }
    await ctx.queue(approveAct(t.timesheetID), `Approve timesheet for employee ${t.employeeID}: ${t.totalHours} hours, ${p.start} to ${p.end}`);
    queued++;
  }
  ctx.log(`approve: ${queued} queued for approval, ${heldCount} held`);
  return { queued, held: heldCount };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { mirror, approve };
