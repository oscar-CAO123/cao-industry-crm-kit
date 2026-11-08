// The maintenance dispatch workflow's three crons. Each reads, drafts and queues; it never sends or allocates.
// A person approves every allocation and every message in the CRM shell. The owner's go-ahead is the job moving to
// Work Order in ServiceM8, which a person does; the dispatch cron only acts on jobs already there.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import type { Job, Settings } from "./types.ts";
import { servicem8 } from "./adapters/servicem8.ts";

const DAY = 864e5;
const assertPlatform = (ctx: Ctx<Settings>) => {
  if (ctx.settings.platform !== "servicem8") throw new Error(`maint: ${ctx.settings.platform} has no adapter in this workflow`);
};

/** Every 10 minutes: new maintenance requests (jobs logged as Quote) into the workflow store. */
export async function intake(ctx: Ctx<Settings>) {
  assertPlatform(ctx);
  let added = 0;
  for (const j of await servicem8.openJobs(ctx)) {
    if (await ctx.store.get("jobs", j.job_uuid)) continue;
    await ctx.store.put("jobs", j.job_uuid, j);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: approved (Work Order) jobs with no allocation get one queued for the default maintenance person. */
export async function dispatch(ctx: Ctx<Settings>) {
  assertPlatform(ctx);
  const staff = ctx.settings.dispatch_staff_uuid;
  if (!staff || !(await servicem8.staffActive(ctx, staff))) throw new Error("maint: dispatch_staff_uuid is not an active ServiceM8 staff member");
  let queued = 0;
  for (const wo of await servicem8.workOrders(ctx)) {
    const job = (await ctx.store.get<Job>("jobs", wo.uuid)) ?? (await servicem8.jobRecord(ctx, wo));
    if (job.status !== "new") continue;
    if (await servicem8.hasAllocation(ctx, job.job_uuid)) {
      job.status = "in-work"; job.staff_uuid = staff; job.dispatched_at = ctx.now.toISOString();
    } else {
      await ctx.queue(servicem8.allocateAct(job.job_uuid, staff, `Allocate "${job.title}" at ${job.address || "no address"} to the maintenance person`));
      job.status = "dispatch-queued"; job.staff_uuid = staff;
      queued++;
    }
    await ctx.store.put("jobs", job.job_uuid, job);
  }
  ctx.log(`dispatch: ${queued} queued for approval`);
  return { queued };
}

/** Daily: learn which allocations were approved, close completed jobs (queue the owner update), chase stalled ones. */
export async function followUp(ctx: Ctx<Settings>) {
  assertPlatform(ctx);
  const days = ctx.settings.follow_up?.after_days ?? [2, 5];
  let queued = 0;
  for (const job of Object.values(await ctx.store.list<Job>("jobs"))) {
    if (job.status === "dispatch-queued") {
      const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `dispatch:${job.job_uuid}`));
      // Allocated once the act succeeded, the same test the quoting workflow uses for a sent quote.
      if (ap && (ap.status === "done" || (ap.results?.[0]?.status ?? 999) < 300)) {
        job.status = "in-work"; job.dispatched_at = ap.started ?? ap.decided ?? ctx.now.toISOString();
      }
    }
    if (job.status === "in-work") {
      const j = await servicem8.jobByUuid(ctx, job.job_uuid);
      if (j?.status === "Completed") job.status = "done";
    }
    if (job.status === "done" && !job.reported && ctx.settings.owner_email) {
      await ctx.queue(servicem8.emailAct(job.job_uuid, ctx.settings.owner_email, `Maintenance complete: ${job.title}`.slice(0, 150),
        `The maintenance request "${job.title}" at ${job.address || "the property"} is complete.`,
        `owner-update:${job.job_uuid}`, `Email the owner that "${job.title}" is complete`));
      job.reported = ctx.now.toISOString();
      queued++;
    } else if (job.status === "in-work" && job.dispatched_at) {
      const n = job.followups?.length ?? 0;
      if (n < days.length && ctx.now.getTime() - Date.parse(job.dispatched_at) >= days[n] * DAY) {
        const text = `Hi ${job.contact.name ?? "there"}, a quick update: the maintenance on "${job.title}" is still with our team. We will be in touch as soon as it is booked.`;
        const act = ctx.settings.follow_up?.channel === "sms" && job.contact.phone
          ? servicem8.smsAct(job.job_uuid, job.contact.phone, text, `follow${n + 1}:${job.job_uuid}`, `progress check ${n + 1} text to the tenant`)
          : job.contact.email
            ? servicem8.emailAct(job.job_uuid, job.contact.email, "Update on your maintenance request", text, `follow${n + 1}:${job.job_uuid}`, `progress check ${n + 1} email to the tenant`)
            : undefined;
        if (act) {
          await ctx.queue(act);
          job.followups = [...(job.followups ?? []), ctx.now.toISOString()];
          queued++;
        }
      }
    }
    await ctx.store.put("jobs", job.job_uuid, job);
  }
  ctx.log(`follow-up: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, dispatch, "follow-up": followUp };
