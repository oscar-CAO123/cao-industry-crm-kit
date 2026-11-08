// VaultRE: open maintenance and tasks, a follow-up task for one user, and a contractor booking as a maintenance job.
// Field names come from VaultRE's official swagger (Task, maintenance job, currentTenants items, addMaintenance path).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Booking, type MaintenanceJob, DAY, KEY, clamp, posInt } from "../types.ts";

const P = "vaultre";

export async function openMaintenance(ctx: Ctx<Settings>): Promise<MaintenanceJob[]> {
  const r = await ctx.draft<{ items?: MaintenanceJob[] }>({ platform: P, op: "getAllMaintenance",
    input: { params: { completed: false, page: 1, pagesize: 100 } }, summary: "read open maintenance jobs" });
  return (r.data?.items ?? []).filter((m) => Number.isSafeInteger(m.id) && m.id > 0);
}

export async function openTasks(ctx: Ctx<Settings>): Promise<{ id: number }[]> {
  const r = await ctx.draft<{ items?: { id: number }[] }>({ platform: P, op: "getTasks",
    input: { params: { completed: false, page: 1, pagesize: 100 } }, summary: "read open tasks" });
  return r.data?.items ?? [];
}

export async function currentTenants(ctx: Ctx<Settings>): Promise<unknown[]> {
  const r = await ctx.draft<{ items?: unknown[] }>({ platform: P, op: "getCurrentTenants",
    input: { params: { page: 1, pagesize: 100 } }, summary: "read current tenants" });
  return r.data?.items ?? [];
}

/** One internal task for one user: it reaches nobody outside the business, so it is a draft. */
export async function followUpTask(ctx: Ctx<Settings>, m: MaintenanceJob): Promise<number | undefined> {
  const user = posInt(ctx.settings.user_id, "user_id");
  const start = new Date(ctx.now.getTime() + (ctx.settings.task_start_days ?? 1) * DAY).toISOString();
  const r = await ctx.draft<{ id?: number }>({ platform: P, op: "addTask", summary: `follow-up task for maintenance job ${m.id}`,
    input: { body: { subject: clamp(`Follow up maintenance job ${m.id}: ${m.summary ?? ""}`, 200),
                     description: clamp(m.description, 2000), start, user: { id: user } } } });
  return r.data?.id;
}

/** A contractor booking is a maintenance job on the lease life: live, so it is queued for approval and never run here. */
export function bookingJob(ctx: Ctx<Settings>, b: Booking): Promise<string> {
  if (!KEY.test(String(b.key))) throw new Error("rental compliance: booking key has characters outside letters, digits, dash, underscore");
  const property = posInt(b.property_id, "property_id"), life = posInt(b.lease_life_id, "lease_life_id");
  const tenancy = posInt(b.tenancy_id, "tenancy_id"), requester = posInt(b.requested_by_id, "requested_by_id");
  return ctx.queue({ platform: P, op: "addMaintenance", key: `booking:${b.key}`,
    summary: `contractor booking at property ${property}: ${clamp(b.summary, 160)}`,
    input: { params: { propertyid: property, lifeid: life },
             body: { summary: clamp(b.summary, 200), description: clamp(b.description, 4000),
                     requestedBy: { id: requester }, tenancy: { id: tenancy }, notifications: [] } } });
}
