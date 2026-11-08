// The status-updates workflow's three crons. Each reads, drafts or queues; none sends. A customer message waits for a person.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Change, type Job, type Seen, type Settings, type Status, UPDATE, keyOf } from "./types.ts";
import { activeJobs, contactFor, queueStatusMessage, routeFor } from "./adapters/servicem8.ts";

const DAY = 864e5;
const notifies = (s: Settings, status: Status) => status === "Unsuccessful" || (s.notify_statuses ?? []).includes(status as "Work Order");

/** Every 30 minutes: read active jobs and record each status change that messages a customer. The first run only records
 *  a baseline, so jobs that already existed send nothing. */
export async function checkStatus(ctx: Ctx<Settings>) {
  const jobs = await activeJobs(ctx);
  const baselined = await ctx.store.get("meta", "baselined");
  const now = ctx.now.toISOString();
  let recorded = 0;
  for (const j of jobs) {
    const prev = await ctx.store.get<Seen>("jobs", j.uuid);
    const from: Status = prev?.status ?? "Quote";
    if (baselined && from !== j.status && notifies(ctx.settings, j.status)) {
      const key = keyOf(`${j.uuid}-${j.status}`);
      if (!(await ctx.store.get("changes", key))) {
        await ctx.store.put("changes", key, { key, job: j, from, to: j.status, detected: now, state: "new" } satisfies Change);
        recorded++;
      }
    }
    if (!prev || prev.status !== j.status) await ctx.store.put("jobs", j.uuid, { status: j.status, seen: now } satisfies Seen);
  }
  if (!baselined) await ctx.store.put("meta", "baselined", { at: now });
  ctx.log(`check-status: ${jobs.length} active, ${recorded} changes recorded${baselined ? "" : " (baseline only)"}`);
  return { read: jobs.length, recorded, baseline: !baselined };
}

/** Hourly: draft each new change into a customer message and queue it for approval. Unsuccessful jobs and clients with no
 *  usable route go to a person. */
export async function draftUpdates(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Change>("changes")).filter((c) => c.state === "new");
  let queued = 0, needsContact = 0, human = 0;
  for (const c of todo) {
    if (c.to === "Unsuccessful" || !(c.to in UPDATE)) {
      c.state = "human"; c.note = "a person writes this message"; human++;
      await ctx.store.put("changes", c.key, c);
      continue;
    }
    const contact = await contactFor(ctx, c.job.company_uuid);
    const route = routeFor(ctx.settings.channel, contact);
    if (!route) {
      c.state = "needs-contact"; c.note = "no usable mobile or email on the client card"; needsContact++;
      await ctx.store.put("changes", c.key, c);
      continue;
    }
    const id = await queueStatusMessage(ctx, c.key, c.job as Job, route, contact, UPDATE[c.to as "Work Order" | "Completed"]);
    c.state = "queued"; c.channel = route; c.approval = id; queued++;
    await ctx.store.put("changes", c.key, c);
  }
  ctx.log(`draft-updates: ${queued} queued, ${needsContact} need a contact, ${human} for a person`);
  return { queued, needs_contact: needsContact, human };
}

/** Daily, 21:00 UTC (7 or 8 am in eastern Australia): an internal digest for the office. Store only, nothing is sent. */
export async function dailyDigest(ctx: Ctx<Settings>) {
  const jobs = await activeJobs(ctx);
  const counts: Record<string, number> = { Quote: 0, "Work Order": 0, Completed: 0, Unsuccessful: 0 };
  const cutoff = ctx.now.getTime() - (ctx.settings.stale_after_days ?? 7) * DAY;
  const stale: { uuid: string; job_address?: string; work_order_date?: string }[] = [];
  for (const j of jobs) {
    counts[j.status]++;
    const t = j.work_order_date ? Date.parse(j.work_order_date) : NaN;
    if (j.status === "Work Order" && Number.isFinite(t) && t < cutoff) stale.push({ uuid: j.uuid, job_address: j.job_address, work_order_date: j.work_order_date });
  }
  const people = Object.values(await ctx.store.list<Change>("changes"))
    .filter((c) => c.state === "human" || c.state === "needs-contact")
    .map((c) => ({ job: c.job.uuid, to: c.to, state: c.state, note: c.note }));
  const digest = { at: ctx.now.toISOString(), counts, stale, for_a_person: people };
  await ctx.store.put("digest", "latest", digest);
  ctx.log(`daily-digest: ${jobs.length} active, ${stale.length} stale work orders, ${people.length} for a person`);
  return digest;
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "check-status": checkStatus, "draft-updates": draftUpdates, "daily-digest": dailyDigest,
};
