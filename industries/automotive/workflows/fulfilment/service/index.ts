// The service-reminder workflow's three crons. Two read and record; one queues reminders for a person to approve.
// Nothing here sends: every message is queued, and the runtime never queues the same reminder twice.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import type { Settings, Due } from "./types.ts";
import { config, addMonths, daysUntil, today, fill, text, esc, EMAIL, PHONE } from "./types.ts";
import { completedJobs, contactOf, inboundSms, uuid } from "./adapters/servicem8.ts";

const PAST_DAYS = 60;    // a service that fell due this long ago still gets a reminder
const AHEAD_DAYS = 90;   // jobs whose service falls due this far ahead are recorded in advance
const reminderKey = (d: Due) => `remind:${d.job_uuid}:${d.due}`;

/** Daily: read completed jobs, work out when each next service falls due, and record the ones in the window. Reads only. */
export async function dueList(ctx: Ctx<Settings>) {
  const c = config(ctx.settings);
  const t = today(ctx.now);
  let added = 0, updated = 0;
  for (const j of await completedJobs(ctx)) {
    const due = addMonths(j.completed, c.interval);
    const ahead = daysUntil(due, t);
    if (ahead < -PAST_DAYS || ahead > AHEAD_DAYS) continue;
    const prev = await ctx.store.get<Due>("due", j.uuid);
    if (prev && prev.due === due) continue;
    const contact = await contactOf(ctx, j.uuid);
    await ctx.store.put("due", j.uuid, { key: j.uuid, platform: "servicem8", job_uuid: j.uuid, address: j.address, description: j.description,
      completed: j.completed, due, contact, seen: ctx.now.toISOString() } satisfies Due);
    if (prev) updated++; else added++;
  }
  ctx.log(`due-list: ${added} new, ${updated} due dates changed`);
  return { added, updated };
}

/** Hourly: queue a reminder for each recorded job whose service falls due inside the window. Every reminder waits for approval. */
export async function remind(ctx: Ctx<Settings>) {
  const c = config(ctx.settings);
  const t = today(ctx.now);
  const business = ctx.settings.business_name ?? "us";
  const due = Object.values(await ctx.store.list<Due>("due"))
    .filter((d) => { const ahead = daysUntil(d.due, t); return ahead <= c.before && ahead >= -PAST_DAYS; })
    .sort((a, b) => a.due.localeCompare(b.due));
  // The run's limit counts only reminders it would queue now: a job already queued, approved or rejected, or with no usable
  // contact, keeps no place in the limit, so the jobs behind it are still reached.
  const fresh: { d: Due; route: "sms" | "email"; phone?: string; email?: string }[] = [];
  let skipped = 0, waiting = 0;
  for (const d of due) {
    if (await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, reminderKey(d)))) { waiting++; continue; }
    const phone = d.contact.phone && PHONE.test(d.contact.phone) ? d.contact.phone : undefined;
    const email = d.contact.email && EMAIL.test(d.contact.email) ? d.contact.email : undefined;
    const route = c.channel === "sms" ? (phone ? "sms" : email ? "email" : undefined) : (email ? "email" : phone ? "sms" : undefined);
    if (!route) { skipped++; continue; }
    fresh.push({ d, route, phone, email });
  }
  let queued = 0;
  for (const { d, route, phone, email } of fresh.slice(0, c.max)) {
    const first = text(d.contact.name?.split(" ")[0] || "there", 40);
    const what = text(`${d.description || "your vehicle"} at ${d.address || "the job address"}`, 200);
    const summary = `Remind ${first} that the service on ${what} falls due ${d.due}. Approve to send.`;
    const msg = fill(c.template, first, business);
    if (route === "sms") {
      await ctx.queue({ platform: "servicem8", op: "messaging-api.send_sms", key: reminderKey(d), summary,
        input: { body: { to: phone, message: msg, regardingJobUUID: d.job_uuid } } });
    } else {
      await ctx.queue({ platform: "servicem8", op: "messaging-api.send_email", key: reminderKey(d), summary,
        input: { body: { to: email, subject: c.subject, htmlBody: `<p>${esc(msg)}</p>`, regardingJobUUID: d.job_uuid } } });
    }
    queued++;
  }
  ctx.log(`remind: ${queued} queued, ${waiting} already queued, approved or rejected, ${skipped} without a usable contact`);
  return { queued, skipped };
}

/** Every 30 minutes: for each reminder a person approved, record any inbound text on that job. Reads only; nothing is answered here. */
export async function replies(ctx: Ctx<Settings>) {
  let found = 0;
  const sent = Object.values(await ctx.store.list<Due>("due")).slice(0, 100);
  for (const d of sent) {
    const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, reminderKey(d)));
    if (!ap || ap.status !== "done" || !uuid(d.job_uuid)) continue;
    const seen = new Set((d.replies ?? []).map((r) => r.uuid));
    const fresh = (await inboundSms(ctx, d.job_uuid)).filter((r) => !seen.has(r.uuid));
    if (!fresh.length) continue;
    await ctx.store.put("due", d.job_uuid, { ...d, replies: [...(d.replies ?? []), ...fresh].slice(-20) } satisfies Due);
    found += fresh.length;
  }
  ctx.log(`replies: ${found} new inbound`);
  return { found };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "due-list": dueList, remind, replies };
