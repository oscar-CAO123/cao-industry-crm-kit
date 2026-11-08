// The client timeline's three crons. Each reads, drafts internal records, or queues. None sends anything to a client.
// Hand-offs arrive as store records from the CRM shell; a status change is queued and runs only when a person approves it.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { getNotes, getTasks, createNote, createTask, addFollower, statusAct } from "./adapters/gohighlevel.ts";
import { checkId, clip, DAY, STATUSES, type CheckIn, type Handoff, type Settings, type Timeline, type TimelineEvent } from "./types.ts";

/** Every 30 minutes: read each watched client's notes and tasks and keep one timeline per client. Reads only. */
export async function timeline(ctx: Ctx<Settings>) {
  let updated = 0;
  for (const w of ctx.settings.watch ?? []) {
    const contact = checkId(w.contact_id, "contact id");
    const notes = await getNotes(ctx, contact);
    const tasks = await getTasks(ctx, contact);
    const events: TimelineEvent[] = [
      ...notes.map((n) => ({ at: String(n.dateAdded ?? ""), kind: "note" as const, id: String(n.id), text: clip(n.body, 1000), by: n.userId })),
      ...tasks.map((t) => ({ at: String(t.dueDate ?? ""), kind: "task" as const, id: String(t.id),
                             text: clip(`${t.title ?? ""}${t.completed ? " (done)" : ""}`, 300), by: t.assignedTo })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
    const last = notes.map((n) => String(n.dateAdded ?? "")).filter(Boolean).sort().at(-1) ?? null;
    await ctx.store.put("timeline", contact, { contact_id: contact, events, last_activity: last, updated: ctx.now.toISOString() } satisfies Timeline);
    updated++;
  }
  ctx.log(`timeline: ${updated} clients read`);
  return { updated };
}

/** Every 15 minutes: a hand-off becomes a note, a follow-up task and a follower. Each step is recorded, so a re-run never repeats one.
 *  A status change is queued for approval, never run here. */
export async function handOff(ctx: Ctx<Settings>) {
  let drafted = 0, queued = 0;
  for (const h of Object.values(await ctx.store.list<Handoff>("handoffs"))) {
    if (h.status !== "new") continue;
    const rec: Handoff = { ...h, done: [...(h.done ?? [])] };
    const save = () => ctx.store.put("handoffs", rec.id, rec);
    const step = async (name: string, fn: () => Promise<unknown>) => {
      if (rec.done!.includes(name)) return;
      await fn();
      rec.done!.push(name);
      await save();
    };
    const contact = checkId(h.contact_id, "contact id");
    const to = checkId(h.to_user_id, "user id");
    const opp = h.opportunity_id ? checkId(h.opportunity_id, "opportunity id") : undefined;
    if (h.status_change && (!opp || !STATUSES.includes(h.status_change) || (h.status_change === "lost" && !h.lost_reason_id))) {
      rec.status = "needs-check";
      await save();
      continue;
    }
    const summary = clip(h.summary, 3000);
    await step("note", () => createNote(ctx, contact, `Hand-off to a team member. ${summary}`));
    await step("task", () => createTask(ctx, contact, { title: "Pick up hand-off", body: summary.slice(0, 1000),
      dueDate: new Date(ctx.now.getTime() + 2 * DAY).toISOString(), assignedTo: to }));
    if (opp) await step("follower", () => addFollower(ctx, opp, to));
    if (h.status_change && opp) {
      await step("queue", async () => {
        await ctx.queue(statusAct(opp, h.status_change!, `status:${rec.id}`, h.lost_reason_id), `Set opportunity ${opp} to ${h.status_change} after hand-off ${rec.id}`);
        queued++;
      });
    }
    rec.status = "drafted";
    await save();
    drafted++;
  }
  ctx.log(`hand-off: ${drafted} drafted, ${queued} status changes queued`);
  return { drafted, queued };
}

/** Daily: a client with no note for check_in_days gets one follow-up task for the owner, at most once per period. */
export async function checkIn(ctx: Ctx<Settings>) {
  const owner = checkId(ctx.settings.gohighlevel.owner_user_id, "owner user id");
  const days = ctx.settings.check_in_days ?? 30;
  let tasks = 0;
  for (const w of ctx.settings.watch ?? []) {
    const contact = checkId(w.contact_id, "contact id");
    const tl = await ctx.store.get<Timeline>("timeline", contact);
    if (!tl) continue; // the timeline cron has not read this client yet
    const quiet = !tl.last_activity || ctx.now.getTime() - Date.parse(tl.last_activity) >= days * DAY;
    if (!quiet) continue;
    const last = await ctx.store.get<CheckIn>("checkins", contact);
    if (last && ctx.now.getTime() - Date.parse(last.task_at) < days * DAY) continue;
    await createTask(ctx, contact, { title: "Check in with client", body: `No note on this client for ${days} days. Last activity: ${tl.last_activity ?? "none recorded"}.`,
      dueDate: new Date(ctx.now.getTime() + 2 * DAY).toISOString(), assignedTo: owner });
    await ctx.store.put("checkins", contact, { contact_id: contact, task_at: ctx.now.toISOString() } satisfies CheckIn);
    tasks++;
  }
  ctx.log(`check-in: ${tasks} tasks`);
  return { tasks };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { timeline, "hand-off": handOff, "check-in": checkIn };
