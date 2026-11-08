// The scheduling-dispatch workflow's three crons. Each is deterministic: it reads, drafts internal records and queues.
// Nothing here sends. Crew allocations and staff notes are internal drafts the office can move in ServiceM8; the client
// text is queued and waits for a person. Judgment (a job that needs a different crew, an overrun, a same-day change)
// belongs to the office, as SKILL.md says.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Allocation, Job, Settings } from "./types.ts";
import { keyOf } from "./types.ts";
import * as s8 from "./adapters/servicem8.ts";

/** Checked at the start of every cron: a bad setting stops the run before any call is made. */
function settingsOf(ctx: Ctx<Settings>): Settings {
  const s = ctx.settings;
  if (!Array.isArray(s.crew) || !s.crew.length || s.crew.length > 50) throw new Error("scheduling-dispatch: settings.crew needs 1 to 50 staff uuids");
  for (const u of s.crew) s8.uuid(u);
  if (s.office_staff_uuid) s8.uuid(s.office_staff_uuid);
  if (s.allocation_window_uuid) s8.uuid(s.allocation_window_uuid);
  const horizon = s.horizon_days ?? 10;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 21) throw new Error("scheduling-dispatch: horizon_days must be 1 to 21");
  const max = s.max_jobs_per_crew_day ?? 3;
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error("scheduling-dispatch: max_jobs_per_crew_day must be 1 to 50");
  return s;
}

/** Every 15 minutes: open Work Order jobs with no crew yet. Read only. */
export async function intake(ctx: Ctx<Settings>) {
  settingsOf(ctx);
  let added = 0;
  for (const j of await s8.openJobs(ctx)) {
    if (await ctx.store.get("jobs", keyOf(j.id))) continue;
    await ctx.store.put("jobs", keyOf(j.id), { ...j, status: "new" } satisfies Job);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 30 minutes: give each waiting job the earliest day a crew member has room, and draft the allocation. */
export async function allocate(ctx: Ctx<Settings>) {
  const s = settingsOf(ctx);
  const todo = Object.values(await ctx.store.list<Job>("jobs")).filter((j) => j.status === "new" || j.status === "no-capacity");
  if (!todo.length) return { allocated: 0, no_capacity: 0 };
  const tz = s.timezone ?? "Australia/Sydney", max = s.max_jobs_per_crew_day ?? 3;
  const days = s8.candidateDays(ctx.now, tz, s.horizon_days ?? 10, s.work_weekends === true);
  const crew = await s8.activeCrew(ctx);
  // Load per day: read once per run, then updated as this run drafts each allocation.
  const load = new Map<string, Map<string, number>>();
  for (const d of days) {
    const m = new Map<string, number>(crew.map((c) => [c, 0]));
    for (const a of await s8.allocationsOn(ctx, d)) if (m.has(String(a.staff_uuid))) m.set(a.staff_uuid, (m.get(a.staff_uuid) ?? 0) + 1);
    load.set(d, m);
  }
  let allocated = 0, noCapacity = 0;
  for (const job of todo) {
    const key = keyOf(job.id);
    // Re-check first: the office may have allocated it by hand, or an earlier run may have drafted it before its store write.
    if ((await s8.allocationsForJob(ctx, job.uuid)).length) { await ctx.store.put("jobs", key, { ...job, status: "allocated", reason: undefined } satisfies Job); continue; }
    let pick: { date: string; staff: string } | undefined;
    for (const d of days) {
      const best = [...load.get(d)!.entries()].filter(([, n]) => n < max).sort((x, y) => x[1] - y[1])[0];   // ties keep crew order
      if (best) { pick = { date: d, staff: best[0] }; break; }
    }
    if (!pick) {
      await ctx.store.put("jobs", key, { ...job, status: "no-capacity", reason: `no crew space in the next ${days.length} working days` } satisfies Job);
      noCapacity++;
      continue;
    }
    const label = s8.dayLabel(pick.date, tz);
    const id = await s8.draftAllocation(ctx, job.uuid, pick.staff, pick.date);
    load.get(pick.date)!.set(pick.staff, (load.get(pick.date)!.get(pick.staff) ?? 0) + 1);
    await ctx.store.put("allocations", key, { job: job.uuid, staff: pick.staff, date: pick.date, uuid: id, created: ctx.now.toISOString() } satisfies Allocation);
    await ctx.store.put("jobs", key, { ...job, status: "allocated", reason: undefined } satisfies Job);
    await s8.draftStaffNote(ctx, job.uuid, pick.staff, label);
    allocated++;
  }
  ctx.log(`allocate: ${allocated} allocated, ${noCapacity} no capacity`);
  return { allocated, no_capacity: noCapacity };
}

/** Every 30 minutes: queue one client text per upcoming allocation. The text waits for approval; a cron never sends it. */
export async function notify(ctx: Ctx<Settings>) {
  const s = settingsOf(ctx);
  if ((s.notify ?? "sms") === "none") return { queued: 0, skipped: 0 };
  const tz = s.timezone ?? "Australia/Sydney";
  const today = s8.candidateDays(ctx.now, tz, 1, true)[0];
  let queued = 0, skipped = 0;
  for (const [key, a] of Object.entries(await ctx.store.list<Allocation>("allocations"))) {
    if (a.notified || a.date < today) continue;
    const job = await ctx.store.get<Job>("jobs", key);
    const contact = await s8.clientContact(ctx, job?.company_uuid);
    if (!contact.mobile) { skipped++; ctx.log(`no mobile for job ${a.job}: nothing queued`); continue; }
    const label = s8.dayLabel(a.date, tz);
    const id = await s8.queueClientText(ctx, a, contact.mobile, s8.clientText(s.business_name, contact.first, label), label);
    await ctx.store.put("allocations", key, { ...a, notified: id } satisfies Allocation);
    queued++;
  }
  ctx.log(`notify: ${queued} queued, ${skipped} without a mobile`);
  return { queued, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, allocate, notify };
