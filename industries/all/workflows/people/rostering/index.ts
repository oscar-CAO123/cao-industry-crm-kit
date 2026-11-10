// The rostering workflow's three crons. Each reads, drafts or queues; none publishes. Publishing a shift tells staff,
// so it only ever waits in the approval queue. Choosing who to roster is the deterministic rule in draft(); a person
// checks the drafts before approving the publish.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Shift, type Shortfall, type Flag, DAY, demandKey, hhmm, overlaps, seconds, label } from "./types.ts";
import * as deputy from "./adapters/deputy.ts";

const HOUR = 3600;

/** Every 2 hours: read rosters, timesheets and swap requests into the store. Reads only; flags late clock-ins. */
export async function sync(ctx: Ctx<Settings>) {
  const grace = (ctx.settings.deputy.late_grace_minutes ?? 5) * 60;
  const rosters = await deputy.rosters(ctx);
  const byId = new Map(rosters.map((r) => [r.Id, r]));
  for (const r of rosters) {
    const sh = deputy.rosterFrom(r);
    await ctx.store.put("rosters", String(r.Id), sh satisfies Shift);
  }
  const since = Math.floor((ctx.now.getTime() - 2 * DAY) / 1000);
  let flagged = 0;
  for (const t of await deputy.timesheets(ctx)) {
    const start = seconds(t.StartTime);
    if (start < since) continue;
    const planned = t.Roster ? byId.get(t.Roster) : undefined;
    const late = planned ? start > seconds(planned.StartTime) + grace : false;
    if (!late && !t.ValidationFlag) continue;
    const reason = [late ? "clocked in after the rostered start" : "", t.ValidationFlag ? "Deputy validation flag set" : ""].filter(Boolean).join("; ");
    await ctx.store.put("flags", `timesheet-${t.Id}`, { timesheet: t.Id, employee: t.Employee, reason, noted: ctx.now.toISOString() } satisfies Flag);
    flagged++;
  }
  for (const s of await deputy.swaps(ctx)) {
    await ctx.store.put("swaps", String(s.Id), { id: s.Id, employee: s.Employee, source: s.SourceRoster, target: s.TargetRoster, status: s.Status, noted: ctx.now.toISOString() });
  }
  ctx.log(`sync: ${rosters.length} rosters, ${flagged} timesheets flagged`);
  return { rosters: rosters.length, flagged };
}

/** Daily: for each demand block in the horizon, draft private shifts for people free for it. Never publishes. */
export async function draft(ctx: Ctx<Settings>) {
  const s = ctx.settings, now = ctx.now.getTime(), horizon = (s.deputy.draft_days_ahead ?? 14) * DAY;
  const todo = s.demand.filter((d) => { const st = Date.parse(d.start); return st >= now && st <= now + horizon; });
  if (!todo.length) return { drafted: 0, shortfalls: 0 };
  const people = (await deputy.employees(ctx)).filter((p) => p.Active !== false && !p.TerminationDate);
  const leave = await deputy.leave(ctx);
  const rosters = (await deputy.rosters(ctx)).map(deputy.rosterFrom);
  let drafted = 0, short = 0;
  for (const d of todo) {
    const start = seconds(d.start), end = seconds(d.end);
    const have = rosters.filter((r) => r.start === start && r.end === end).length;   // shifts already drafted for this exact block, from an earlier run
    let need = d.headcount - have;
    const free = people.filter((p) =>
      !leave.some((l) => l.Employee === p.Id && overlaps(Date.parse(l.Start) / 1000, Date.parse(l.End) / 1000, start, end)) &&
      !rosters.some((r) => r.employee === p.Id && overlaps(r.start, r.end, start, end)))
      .sort((a, b) => a.Id - b.Id);
    let made = 0;
    for (const p of free) {
      if (made >= need) break;
      const id = await deputy.draftShift(ctx, { employee: p.Id, start, end, date: d.date });
      const sh: Shift = { id: String(id), employee: p.Id, employee_name: label(p.DisplayName ?? `${p.FirstName ?? ""} ${p.LastName ?? ""}`.trim()), date: d.date, start, end, published: false };
      await ctx.store.put("rosters", String(id), sh);
      rosters.push(sh);
      made++; drafted++;
    }
    if (made < need) {
      const key = demandKey(d);
      const reason = `${need - made} short: no one free after approved leave, existing shifts and inactive staff. Window ${d.date} ${hhmm(start)}-${hhmm(end)}.`;
      await ctx.store.put("shortfalls", key, { demand: key, wanted: d.headcount, drafted: have + made, reason, noted: ctx.now.toISOString() } satisfies Shortfall);
      short++;
    }
  }
  ctx.log(`draft: ${drafted} shifts drafted, ${short} blocks short`);
  return { drafted, shortfalls: short };
}

/** Daily: queue a publish for each unpublished draft starting inside the publish window. Each one waits for a person. */
export async function publish(ctx: Ctx<Settings>) {
  const days = ctx.settings.deputy.publish_days_ahead ?? 7, now = ctx.now.getTime() / 1000;
  const due = Object.values(await ctx.store.list<Shift>("rosters")).filter((sh) => !sh.published && sh.start >= now && sh.start <= now + days * DAY / 1000);
  for (const sh of due) await ctx.queue(deputy.publishAct(sh), `publish shift ${sh.id}, ${sh.date}, ${hhmm(sh.start)}-${hhmm(sh.end)}`);
  ctx.log(`publish: ${due.length} shifts waiting for approval`);
  return { waiting: due.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { sync, draft, publish };
