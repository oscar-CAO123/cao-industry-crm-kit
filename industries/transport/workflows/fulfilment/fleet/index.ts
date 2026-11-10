// The fleet service planner's two crons. Each reads and drafts into the store and queues bookings for approval.
// A cron never books: MakeBooking reaches the workshop, so it is a live operation and waits for a person.
import { reject, type Approval, type Ctx } from "../../../../../core/workflows/runtime.ts";
import { checkId, plannedServices, openIssues, bookingAct } from "./adapters/trackunit.ts";
import type { FleetRecord, PlanRecord, Settings } from "./types.ts";

const DUE = new Set(["OVERDUE", "UPCOMING"]);

function vehicles(s: Settings): string[] {
  if (!Array.isArray(s.assets) || !s.assets.length) throw new Error("fleet: settings.assets lists no vehicles");
  return s.assets.map((a) => checkId(a, "vehicle"));
}

/** Every 2 hours: read each vehicle's planned services and open device issues into the fleet snapshot. */
export async function status(ctx: Ctx<Settings>) {
  const ids = vehicles(ctx.settings);
  let due = 0, issues = 0;
  for (const asset of ids) {
    const rec: FleetRecord = {
      asset, checked: ctx.now.toISOString(),
      due: (await plannedServices(ctx, asset)).filter((p) => DUE.has(p.status)),
      open_issues: await openIssues(ctx, asset),
    };
    due += rec.due.length; issues += rec.open_issues;
    await ctx.store.put("fleet", asset, rec);
  }
  ctx.log(`status: ${ids.length} vehicles, ${due} services due, ${issues} open device issues`);
  return { vehicles: ids.length, due, open_issues: issues };
}

/** Hourly: re-read each vehicle's due services (never from the snapshot alone), withdraw any pending booking whose service
 *  is no longer due (already booked or completed), draft the plan, and queue one booking per due service. */
export async function plan(ctx: Ctx<Settings>) {
  const ids = vehicles(ctx.settings);
  let approvals = 0, withdrawn = 0;
  for (const asset of ids) {
    const due = (await plannedServices(ctx, asset)).filter((p) => DUE.has(p.status));
    const dueIds = new Set(due.map((d) => d.plannedServiceId));
    const last = await ctx.store.get<PlanRecord>("plans", asset);
    for (const id of last?.approvals ?? []) {
      const ap = await ctx.store.get<Approval>("approvals", id);
      const service = ap?.acts[0]?.input?.body?.plannedServiceId;
      if (ap?.status === "pending" && !dueIds.has(service)) { await reject(ctx.workflow, ctx.store, id, "plan cron", ctx.now); withdrawn++; }
    }
    const queued: string[] = [];
    for (const d of due) {
      queued.push(await ctx.queue(bookingAct(asset, d.plannedServiceId), `Book ${d.status.toLowerCase()} service for vehicle ${asset} (plan ${d.servicePlanId})`));
    }
    const rec: PlanRecord = { asset, drafted: ctx.now.toISOString(), due: due.map((d) => d.plannedServiceId), approvals: queued };
    await ctx.store.put("plans", asset, rec);
    approvals += queued.length;
  }
  ctx.log(`plan: ${approvals} bookings waiting for approval, ${withdrawn} withdrawn`);
  return { approvals };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { status, plan };
