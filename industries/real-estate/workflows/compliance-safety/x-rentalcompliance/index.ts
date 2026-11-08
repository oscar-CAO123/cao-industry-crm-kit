// The rental compliance workflow's three crons. watch reads, draft drafts internal tasks, booking queues one live
// contractor job for approval. Nothing here sends. Judgment (whether a certificate is in order) stays with the agent skill.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Booking, DAY } from "./types.ts";
import * as vaultre from "./adapters/vaultre.ts";

/** Every 30 minutes: read open work and keep a snapshot. Writes nothing to VaultRE. */
export async function watch(ctx: Ctx<Settings>) {
  const jobs = await vaultre.openMaintenance(ctx);
  const tasks = await vaultre.openTasks(ctx);
  const tenants = await vaultre.currentTenants(ctx);
  await ctx.store.put("snapshot", "latest", { at: ctx.now.toISOString(), open_maintenance: jobs.length,
    open_tasks: tasks.length, current_tenants: tenants.length, maintenance_ids: jobs.map((j) => j.id) });
  ctx.log(`watch: ${jobs.length} open maintenance, ${tasks.length} open tasks, ${tenants.length} current tenants`);
  return { open_maintenance: jobs.length, open_tasks: tasks.length, current_tenants: tenants.length };
}

/** Hourly: an open maintenance job that has gone stale gets one internal follow-up task. Re-runs never repeat it. */
export async function draft(ctx: Ctx<Settings>) {
  const stale = ctx.settings.stale_days ?? 3;
  let drafted = 0, skipped = 0;
  for (const m of await vaultre.openMaintenance(ctx)) {
    const key = `maint-${m.id}`;
    if (await ctx.store.get("followups", key)) { skipped++; continue; }
    const inserted = Date.parse(m.inserted ?? "");
    if (!Number.isFinite(inserted) || ctx.now.getTime() - inserted < stale * DAY) { skipped++; continue; }
    const taskId = await vaultre.followUpTask(ctx, m);
    await ctx.store.put("followups", key, { maintenance_id: m.id, task_id: taskId ?? null, at: ctx.now.toISOString() });
    drafted++;
  }
  ctx.log(`draft: ${drafted} follow-up tasks drafted, ${skipped} skipped`);
  return { drafted, skipped };
}

/** Daily: queue each new contractor booking for approval. The booking is marked queued, so it is queued once. */
export async function booking(ctx: Ctx<Settings>) {
  let queued = 0;
  for (const b of Object.values(await ctx.store.list<Booking>("bookings"))) {
    if (b.status !== "new") continue;
    await vaultre.bookingJob(ctx, b);
    await ctx.store.put("bookings", b.key, { ...b, status: "queued" } satisfies Booking);
    queued++;
  }
  ctx.log(`booking: ${queued} queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { watch, draft, booking };
