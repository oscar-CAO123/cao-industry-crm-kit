// The defects workflow's three crons. Each reads and drafts internal records, or queues an email for approval; none sends.
// Judgment (what a defect is, whether a fix is good enough, whether to sign off) stays with the people in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Defect, JobCloseOut, Settings, TradeContact } from "./types.ts";
import { DAY, EMAIL, esc } from "./types.ts";
import { servicem8 } from "./adapters/servicem8.ts";

export const ADAPTERS = { servicem8 };
const MAX_JOBS = 100;

/** The trade who chases a defect: the first contact whose match word appears in the defect's name, with a usable email. */
function tradeFor(s: Settings, name: string): TradeContact | undefined {
  const n = name.toLowerCase();
  return (s.trade_contacts ?? []).find((t) => t.match && n.includes(t.match.toLowerCase()) && EMAIL.test(t.email));
}

/** Update every open defect from its job checklist: ticked means fixed, removed or inactive means withdrawn. */
async function refresh(ctx: Ctx<Settings>) {
  const open = Object.values(await ctx.store.list<Defect>("defects")).filter((d) => d.status === "open");
  const byJob = new Map<string, Defect[]>();
  for (const d of open) byJob.set(d.job_uuid, [...(byJob.get(d.job_uuid) ?? []), d]);
  for (const [job, ds] of [...byJob].slice(0, MAX_JOBS)) {
    const items = new Map((await servicem8.defectItems!(ctx, job)).map((i) => [i.uuid, i]));
    for (const d of ds) {
      const it = items.get(d.id);
      if (!it || !it.active) d.status = "withdrawn";
      else if (it.completed_at) { d.status = "fixed"; d.fixed_at = it.completed_at; }
      else continue;
      await ctx.store.put("defects", d.id, d);
    }
  }
}

/** Every 30 minutes: record each new defect item on a work-order job, with one task on the job for staff. */
export async function logDefects(ctx: Ctx<Settings>) {
  let logged = 0, tasks = 0;
  for (const j of (await servicem8.openJobs!(ctx)).slice(0, MAX_JOBS)) {
    for (const it of await servicem8.defectItems!(ctx, j.uuid)) {
      let d = await ctx.store.get<Defect>("defects", it.uuid);
      if (!d) {
        if (!it.active) continue;
        d = { id: it.uuid, job_uuid: j.uuid, company_uuid: j.company_uuid, address: j.address, name: it.name, status: it.completed_at ? "fixed" : "open",
              logged: ctx.now.toISOString(), fixed_at: it.completed_at, reminders: [] };
        await ctx.store.put("defects", it.uuid, d);
        logged++;
      }
      // A task that failed to create is tried again; one that was created is never repeated ("created" when the platform gave no id).
      if (!d.task_ref && d.status !== "withdrawn") {
        d.task_ref = (await servicem8.createTask!(ctx, j.uuid, `Defect: ${d.name}`.slice(0, 200), `Logged from the ${ctx.settings.defect_section} checklist on this job.`)) ?? "created";
        await ctx.store.put("defects", it.uuid, d);
        tasks++;
      }
    }
  }
  ctx.log(`log-defects: ${logged} new, ${tasks} tasks`);
  return { logged, tasks };
}

/** Daily: read which defects are fixed, then queue a reminder to the trade for each open defect that is due. */
export async function chase(ctx: Ctx<Settings>) {
  await refresh(ctx);
  const s = ctx.settings, first = s.first_reminder_after_days ?? 1, every = s.reminder_every_days ?? 3;
  let queued = 0, noContact = 0;
  for (const d of Object.values(await ctx.store.list<Defect>("defects"))) {
    if (d.status !== "open") continue;
    const last = d.reminders.at(-1);
    const dueAt = last ? Date.parse(last) + every * DAY : Date.parse(d.logged) + first * DAY;
    if (ctx.now.getTime() < dueAt) continue;
    const trade = tradeFor(s, d.name);
    if (!trade) { noContact++; ctx.log(`no trade contact matches "${d.name}": add one to trade_contacts`); continue; }
    await servicem8.queueEmail!(ctx, {
      to: trade.email, jobUuid: d.job_uuid, key: `chase-${d.id}-${d.reminders.length + 1}`,
      subject: `Open defect: ${d.name}`.slice(0, 200),
      html: `<p>Hi ${esc(trade.name)},</p><p>The defect &ldquo;${esc(d.name)}&rdquo; is still open at ${esc(d.address)}. Please fix it and tick it off on the job checklist.</p>`,
      summary: `Reminder to ${trade.name} for "${d.name}" at ${d.address}`,
    });
    d.reminders = [...d.reminders, ctx.now.toISOString()];
    await ctx.store.put("defects", d.id, d);
    queued++;
  }
  ctx.log(`chase: ${queued} queued, ${noContact} without a trade contact`);
  return { queued, no_trade_contact: noContact };
}

/** Daily: when every defect on a job is fixed, draft an internal sign-off task and queue the client's sign-off email once. */
export async function closeOut(ctx: Ctx<Settings>) {
  await refresh(ctx);
  const byJob = new Map<string, Defect[]>();
  for (const d of Object.values(await ctx.store.list<Defect>("defects"))) {
    if (d.status === "withdrawn") continue;
    byJob.set(d.job_uuid, [...(byJob.get(d.job_uuid) ?? []), d]);
  }
  let closed = 0, queued = 0;
  for (const [job, ds] of byJob) {
    if (!ds.every((d) => d.status === "fixed")) continue;
    const co = (await ctx.store.get<JobCloseOut>("jobs", job)) ?? { job_uuid: job };
    if (co.client_notified) continue;
    if (!co.task_ref) {
      co.task_ref = (await servicem8.createTask!(ctx, job, "Defects fixed: check and sign off", `All ${ds.length} defect(s) on this job are fixed. Check them, then approve the client sign-off email.`)) ?? "created";
      await ctx.store.put("jobs", job, co);
      closed++;
    }
    const client = await servicem8.clientContact!(ctx, ds[0].company_uuid);
    if (!client.email) { ctx.log(`no client email on job ${job}: sign-off not queued`); continue; }
    await servicem8.queueEmail!(ctx, {
      to: client.email, jobUuid: job, key: `closeout-${job}`,
      subject: `Defects fixed at ${ds[0].address}`.slice(0, 200),
      html: `<p>Hi ${esc(client.name ?? "there")},</p><p>All the defects found on your job at ${esc(ds[0].address)} are fixed. Let us know if you are happy for us to close the job out.</p>`,
      summary: `Client sign-off for ${ds[0].address} (${ds.length} defects fixed)`,
    });
    co.client_notified = ctx.now.toISOString();
    await ctx.store.put("jobs", job, co);
    queued++;
  }
  ctx.log(`close-out: ${closed} tasks, ${queued} sign-off emails queued`);
  return { tasks: closed, sign_off_queued: queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "log-defects": logDefects, chase, "close-out": closeOut };
