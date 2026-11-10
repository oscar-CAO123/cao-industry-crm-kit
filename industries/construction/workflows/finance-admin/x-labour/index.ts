// The labour-by-person workflow's two crons. Each reads ServiceM8 clock events (or Procore timecards), drafts Xero timesheet lines, or queues one
// approval for a person. No cron approves a timesheet or pays anyone.
import { type Ctx, type Approval, reject } from "../../../../../core/workflows/runtime.ts";
import { type Holds, type Settings, type ShiftRec, type XeroTimesheet, GUID, HOLDS_NS, clean, keyFor, period } from "./types.ts";
import { shiftsFrom, staffEvents } from "./adapters/servicem8.ts";
import { timecardHours } from "./adapters/procore.ts";
import { addLine, approveAct, createTimesheet, timesheetsIn } from "./adapters/xero.ts";

const DEFAULT_MAX_HOURS = 12;

/** A timesheet approval still waiting for a person is withdrawn once its employee is held, so partial hours cannot be approved. */
async function withdrawHeld(ctx: Ctx<Settings>, p: { start: string; end: string }, held: string[]): Promise<number> {
  const pending = Object.values(await ctx.store.list<Approval>("approvals"))
    .filter((a) => a.workflow === ctx.workflow.id && a.status === "pending");
  if (!pending.length || !held.length) return 0;
  const heldSet = new Set(held);
  const employeeOf = new Map((await timesheetsIn(ctx, p)).map((t) => [t.timesheetID, t.employeeID]));
  let withdrawn = 0;
  for (const ap of pending) {
    const sheet = String((ap.acts[0]?.input?.params as { TimesheetID?: string } | undefined)?.TimesheetID ?? "");
    if (heldSet.has(employeeOf.get(sheet) ?? "")) { await reject(ctx.workflow, ctx.store, ap.id, "mirror", ctx.now); withdrawn++; }
  }
  return withdrawn;
}

/** The Draft timesheet a person already has for the period in Xero, if a crashed run created one the store never recorded. */
async function draftFor(ctx: Ctx<Settings>, employee: string, p: { start: string; end: string }): Promise<string | undefined> {
  const found = (await timesheetsIn(ctx, p, "Draft")).filter((t: XeroTimesheet) => t.employeeID === employee);
  if (found.length > 1) throw new Error("more than one draft timesheet for this person in the period");
  return found[0]?.timesheetID;
}

/** Every 30 minutes: ServiceM8 clock events for the pay period become draft lines on each person's Xero timesheet.
 *  A complete shift is written once. A shift over the daily limit is held. A person whose clock events do not pair, or who is
 *  still clocked on, is held from approval. A write with an unclear outcome is marked needs-check and never retried on its own. */
export async function mirror(ctx: Ctx<Settings>) {
  const s = ctx.settings, p = period(s);
  if (!GUID.test(String(s.earnings_rate_id ?? ""))) throw new Error("earnings_rate_id must be a Xero earnings rate GUID");
  const max = s.max_hours_per_shift ?? DEFAULT_MAX_HOURS;
  const at = ctx.now.toISOString();
  const holdKey = keyFor("period", p.start);
  // The hours come from ServiceM8 clock events, or from Procore timecards when `procore` is set. Procore entries are already hours, so there is nothing to pair.
  const src = s.procore ? await timecardHours(ctx, p) : undefined;
  const { events, bad } = src ? { events: [], bad: src.bad } : await staffEvents(ctx, p);
  if (bad) {
    // A clock row that does not check out means nothing can be trusted for this period: everyone mapped is held until a person checks.
    const everyone = Object.values(s.employee_map ?? {}).filter((g) => GUID.test(g));
    await ctx.store.put(HOLDS_NS, holdKey, { employees: everyone, at, start: p.start, end: p.end } satisfies Holds);
    await withdrawHeld(ctx, p, everyone);
    ctx.log(`mirror: ${bad} clock row(s) did not check out, so every mapped person is held`);
    return { blocked: bad };
  }
  const { shifts, open, problem } = src ? { shifts: src.shifts, open: [] as string[], problem: [] as string[] } : shiftsFrom(events);
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
    const base = { period: p.start, staff: sh.staff, date: sh.date, hours: sh.hours, at, ...(src ? { source: "procore" as const } : {}) };
    if (sh.hours > max) {
      flagged++;
      await ctx.store.put("shifts", rk, { ...base, state: "flagged", reason: `${sh.hours} hours in one shift, over ${max}` } satisfies ShiftRec);
      continue;
    }
    await ctx.store.put("shifts", rk, { ...base, state: "creating" } satisfies ShiftRec);
    try {
      const line = { date: sh.date, earningsRateID: s.earnings_rate_id, numberOfUnits: sh.hours };
      const tsKey = keyFor("xts", employee, p.start);
      let existing = await ctx.store.get<string>("xts", tsKey);
      if (!existing) existing = await draftFor(ctx, employee, p);
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
  if (src) {
    // An entry mirrored while it was in the paid status can change in Procore afterwards: reverted, deleted, or its hours edited. The Xero draft
    // line stays, so that person is held from approval until a person checks, instead of approving hours Procore no longer shows.
    const current = new Map(src.shifts.map((sh) => [keyFor("shift", sh.key), sh]));
    for (const [rk, rec] of Object.entries(await ctx.store.list<ShiftRec>("shifts"))) {
      if (rec.source !== "procore" || rec.period !== p.start || rec.state !== "mirrored") continue;
      const now = current.get(rk);
      if (!now || now.hours !== rec.hours || now.date !== rec.date) {
        // Recorded as needs-check, like any shift with an unclear outcome: that holds the person on every run until a person looks, and it is logged once.
        await ctx.store.put("shifts", rk, { ...rec, state: "needs-check", reason: "the Procore entry changed or left the paid status after it was mirrored", at } satisfies ShiftRec);
        ctx.log(`mirror: a mirrored Procore entry for ${rec.staff} on ${rec.date} changed or left the paid status: held from approval`);
      }
    }
  }
  for (const r of Object.values(await ctx.store.list<ShiftRec>("shifts"))) if (r.period === p.start && r.state !== "mirrored") held.add(r.staff);
  const employees = [...held].map((st) => s.employee_map?.[st]).filter((g): g is string => !!g && GUID.test(g));
  await ctx.store.put(HOLDS_NS, holdKey, { employees, at, start: p.start, end: p.end } satisfies Holds);
  const withdrawn = await withdrawHeld(ctx, p, employees);
  ctx.log(`mirror: ${withdrawn} queued approval(s) withdrawn`);
  ctx.log(`mirror: ${mirrored} mirrored, ${flagged} held over the daily limit, ${unmapped} without a Xero employee, ${failed} need a check, ${employees.length} held`);
  return { mirrored, flagged, unmapped, failed, held: employees.length };
}

/** Hourly: each Draft timesheet with hours is queued for approval, unless its person is held. Runs only once mirror has run for the period.
 *  Approval itself is queued, never run here. */
export async function approve(ctx: Ctx<Settings>) {
  const p = period(ctx.settings);
  const holds = await ctx.store.get<Holds>(HOLDS_NS, keyFor("period", p.start));
  if (!holds) return { waiting: "mirror has not run for this period" };
  const heldSet = new Set(holds.employees);
  let queued = 0, heldCount = 0;
  for (const t of await timesheetsIn(ctx, p, "Draft")) {
    if (!(t.totalHours > 0)) continue;
    if (heldSet.has(t.employeeID)) { heldCount++; continue; }
    await ctx.queue(approveAct(t), `Approve timesheet for employee ${t.employeeID}: ${t.totalHours} hours, ${p.start} to ${p.end}`);
    queued++;
  }
  ctx.log(`approve: ${queued} queued for approval, ${heldCount} held`);
  return { queued, held: heldCount };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { mirror, approve };
