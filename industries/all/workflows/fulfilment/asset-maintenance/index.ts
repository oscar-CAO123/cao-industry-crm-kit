// The asset-maintenance workflow's three crons. Each reads, drafts internal Work Order jobs, or queues one reminder for approval.
// Nothing here sends. Judgment (taking a vehicle out of service, choosing a workshop, a parts order) belongs to the office, as SKILL.md says.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Asset, type ServiceRecord, type DefectRecord, UUID, keyOf, settingsOf, ID } from "./types.ts";
import * as tu from "./adapters/trackunit.ts";
import * as s8 from "./adapters/servicem8.ts";

/** Every 6 hours: the asset register from Trackunit. Read only. */
export async function register(ctx: Ctx<Settings>) {
  settingsOf(ctx.settings);
  let added = 0;
  for (const a of await tu.assets(ctx, ctx.now)) {
    const k = keyOf(`trackunit:${a.id}`);
    const prev = await ctx.store.get<Asset>("assets", k);
    await ctx.store.put("assets", k, { ...(prev ?? {}), ...a } satisfies Asset);
    if (!prev) added++;
  }
  ctx.log(`register: ${added} new`);
  return { added };
}

/** Daily: each planned service that is overdue, or due within the window, becomes one Work Order job. Overdue ones also queue a reminder. */
export async function serviceDue(ctx: Ctx<Settings>) {
  const s = settingsOf(ctx.settings);
  const days = s.service_window_days ?? 14;
  const assets = Object.values(await ctx.store.list<Asset>("assets")).slice(0, s.max_assets ?? 50);
  let jobs = 0, queued = 0;
  for (const a of assets) {
    if (!ID.test(a.id)) continue;
    for (const p of await tu.plannedServices(ctx, a.id)) {
      const due = p.status === "OVERDUE" || ((p.status === "PLANNED" || p.status === "UPCOMING") && tu.withinDays(p.predictedServiceTime, ctx.now, days));
      if (!due) continue;
      const k = keyOf(`service:${a.id}:${p.plannedServiceId}`);
      let rec = await ctx.store.get<ServiceRecord>("services", k);
      if (!rec) {
        const job = await s8.createJob(ctx, { title: `Service due: ${a.name}`, address: s.depot_address,
          description: `${p.name} for ${a.name} is ${p.status.toLowerCase()}${p.predictedServiceTime ? `, predicted ${p.predictedServiceTime}` : ""}. Trackunit plan ${p.servicePlanId}.` });
        rec = { key: k, asset: a.id, plan: p.servicePlanId, planned: p.plannedServiceId, status: p.status, job, created: ctx.now.toISOString() };
        await ctx.store.put("services", k, rec);
        jobs++;
      }
      if (p.status === "OVERDUE" && s.reminder_email && UUID.test(rec.job)) {
        await ctx.queue(s8.overdueReminder(s.reminder_email, rec.job, a.name, p.name, k), `overdue reminder to ${s.reminder_email} for ${a.name}`);
        queued++;
      }
    }
  }
  ctx.log(`service-due: ${jobs} jobs drafted, ${queued} reminders queued`);
  return { jobs, queued };
}

/** Every 30 minutes: each failed inspection response becomes one Work Order job, once. */
export async function defects(ctx: Ctx<Settings>) {
  const s = settingsOf(ctx.settings);
  let jobs = 0;
  for (const d of await tu.failedResponses(ctx, ctx.now)) {
    if (!ID.test(d.assetId)) continue;
    const k = keyOf(`defect:${d.id}`);
    if (await ctx.store.get("defects", k)) continue;
    const asset = await ctx.store.get<Asset>("assets", keyOf(`trackunit:${d.assetId}`));
    const name = asset?.name ?? `asset ${d.assetId}`;
    const job = await s8.createJob(ctx, { title: `${d.critical ? "CRITICAL defect" : "Defect"}: ${name}`, address: s.depot_address,
      description: `${d.critical ? "Critical failure" : "Failed check"} on ${name}: ${d.text}` });
    await ctx.store.put("defects", k, { key: k, asset: d.assetId, response: d.id, critical: d.critical, job, created: ctx.now.toISOString() } satisfies DefectRecord);
    jobs++;
  }
  ctx.log(`defects: ${jobs} jobs drafted`);
  return { jobs };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { register, "service-due": serviceDue, defects };
