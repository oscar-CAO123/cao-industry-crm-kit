// The due dates workflow's two crons. scan reads and drafts an internal task. chase reads and queues a client email.
// Neither cron sends anything: the chase email waits in the approval queue until a person approves it.
import { approvalId, safeKey, type Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings } from "./types.ts";
import { awaitingPayment, openProjects, draftDeadlineTask, chaseAct, intSetting, daysBetween, todayUtc } from "./adapters/xero.ts";

/** Every morning: read the invoices still owed and the open projects. Keep both in the register, and draft one internal
 *  task in Xero Projects for each project deadline inside the window. Nothing reaches a client. */
export async function scan(ctx: Ctx<Settings>) {
  const invoices = await awaitingPayment(ctx);
  for (const inv of invoices) await ctx.store.put("invoices", safeKey(`inv:${inv.id}`), { ...inv, seen: ctx.now.toISOString() });
  const today = todayUtc(ctx.now), window = intSetting(ctx.settings.deadline_window_days, 1, 60, 14);
  const projects = await openProjects(ctx);
  let tasks = 0;
  for (const p of projects) {
    await ctx.store.put("projects", safeKey(`proj:${p.id}`), { ...p, seen: ctx.now.toISOString() });
    if (!p.deadline || daysBetween(today, p.deadline) > window) continue;   // no deadline, or not yet inside the window
    const key = safeKey(`task:${p.id}:${p.deadline}`);
    if (await ctx.store.get("tasks", key)) continue;                         // one task per deadline, ever
    const taskId = await draftDeadlineTask(ctx, p, p.deadline);
    await ctx.store.put("tasks", key, { task_id: taskId, project_id: p.id, deadline: p.deadline, created: ctx.now.toISOString() });
    tasks++;
  }
  const overdue = invoices.filter((i) => i.days_overdue > 0).length;
  ctx.log(`scan: ${invoices.length} invoices owed (${overdue} overdue), ${projects.length} open projects, ${tasks} tasks drafted`);
  return { invoices: invoices.length, overdue, projects: projects.length, tasks_drafted: tasks };
}

/** Every morning: queue Xero's invoice email for each invoice overdue by the set number of days. A repeat run queues nothing new. */
export async function chase(ctx: Ctx<Settings>) {
  const after = intSetting(ctx.settings.chase_after_days, 1, 90, 7);
  const due = (await awaitingPayment(ctx)).filter((i) => i.days_overdue >= after);
  let queued = 0;
  for (const inv of due) {
    const act = chaseAct(inv, Math.floor(inv.days_overdue / after));   // one chase per step: at 7 days, again at 14, and so on
    const existed = await ctx.store.get("approvals", approvalId(ctx.workflow.id, act.key!));
    await ctx.queue(act);
    if (!existed) queued++;
  }
  ctx.log(`chase: ${due.length} overdue past ${after} days, ${queued} queued for approval`);
  return { overdue: due.length, queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { scan, chase };
