// The maintenance workflow's four crons. Each is deterministic: it reads, drafts and queues; it never sends.
// Judgment (matching a fault to a machine, checking meter readings or service intervals) belongs to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Closed, Request, Settings } from "./types.ts";
import { servicem8, lockoutChecklist, completedJobs, bookingEmail } from "./adapters/servicem8.ts";

/** Every 10 minutes: open work orders from ServiceM8, each matched to its machine. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const e of await servicem8.openJobs!(ctx)) {
    if (await ctx.store.get("requests", e.id)) continue;
    await ctx.store.put("requests", e.id, { ...e, status: "new" } satisfies Request);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: add the lockout and isolation checklist to each new work order, once. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Request>("requests")).filter((r) => r.status === "new");
  let drafted = 0, steps = 0;
  for (const r of todo) {
    steps += await lockoutChecklist(ctx, r);
    await ctx.store.put("requests", r.id, { ...r, status: "checklist-drafted" } satisfies Request);
    drafted++;
  }
  ctx.log(`draft: ${drafted} checklists, ${steps} steps added`);
  return { drafted, steps };
}

/** Every 30 minutes: queue the booking note to each requester who has an email address. Nothing is sent here. */
export async function notify(ctx: Ctx<Settings>) {
  let queued = 0, noContact = 0;
  for (const r of Object.values(await ctx.store.list<Request>("requests"))) {
    if (r.status !== "checklist-drafted") continue;
    if (!r.contact.email) {
      await ctx.store.put("requests", r.id, { ...r, status: "no-contact" } satisfies Request);
      noContact++;
      continue;
    }
    const to = r.contact.email;
    const id = await ctx.queue({ platform: "servicem8", op: "messaging-api.send_email", key: `notify:${r.id}`,
      summary: `Booking note to ${to} for ${r.title}`, input: { body: bookingEmail(ctx, r, to) } });
    await ctx.store.put("requests", r.id, { ...r, status: "notify-queued" } satisfies Request);
    queued++;
    ctx.log(`notify: ${id}`);
  }
  ctx.log(`notify: ${queued} queued, ${noContact} without an email`);
  return { queued, no_contact: noContact };
}

/** Daily: read completed jobs and the parts used on them into the store. Reads only. */
export async function closeOut(ctx: Ctx<Settings>) {
  let added = 0;
  for (const j of await completedJobs(ctx)) {
    if (await ctx.store.get("closed", j.id)) continue;
    await ctx.store.put("closed", j.id, { ...j, closed: j.closed || ctx.now.toISOString() } satisfies Closed);
    added++;
  }
  ctx.log(`close-out: ${added} completed jobs recorded`);
  return { added };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, notify, "close-out": closeOut };
