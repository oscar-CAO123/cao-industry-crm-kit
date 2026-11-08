// The plant and equipment workflow's two crons. Neither sends or changes a live record: the register cron reads Trackunit and
// ServiceM8 and keeps its rows in the workflow store; the cost cron reads workshop parts and only queues the owner's summary.
// Judgment (which plant a repair belongs to, what to do about a machine's cost) belongs to the agent in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type PlantRow, type JobCost, checkSettings, norm, round } from "./types.ts";
import { readRegister } from "./adapters/trackunit.ts";
import { readAssets, readWorkshopJobs, readJobParts, queueCostSummary } from "./adapters/servicem8.ts";

/** Hourly, at twenty past: read the Trackunit plant register and the ServiceM8 asset list, and keep each plant item with
 *  whether ServiceM8 has an asset of the same name. Reads only. */
export async function registerWatch(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const plant = await readRegister(ctx);
  const s8 = await readAssets(ctx);
  const byName = new Map(s8.map((a) => [norm(a.name), a.uuid] as const));
  let matched = 0;
  for (const t of plant) {
    const su = byName.get(norm(t.name));
    if (su) matched++;
    const row: PlantRow = { key: safeKey(`trackunit:${t.id}`), trackunit_id: t.id, name: t.name, serial: t.serial, brand: t.brand,
      model: t.model, type: t.type, telematics_devices: t.telematics_devices, servicem8_uuid: su, in_servicem8: !!su, checked: ctx.now.toISOString() };
    await ctx.store.put("plant", row.key, row);
  }
  ctx.log(`register-watch: ${plant.length} plant items, ${matched} matched to a ServiceM8 asset by name`);
  return { plant: plant.length, matched, unmatched: plant.length - matched };
}

/** Daily, at 21:00 UTC (7 or 8 am in eastern Australia): total the parts on each workshop job, keep the figures, and queue the
 *  owner's summary of the largest ones. The summary waits for a person to approve it. */
export async function costWatch(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const jobs = (await readWorkshopJobs(ctx)).slice(0, 200);
  const rows: JobCost[] = [];
  for (const j of jobs) {
    const { parts, lines } = await readJobParts(ctx, j.uuid);
    const row: JobCost = { key: safeKey(`s8job:${j.uuid}`), job_uuid: j.uuid, description: j.description, parts_ex_gst: parts, lines, checked: ctx.now.toISOString() };
    await ctx.store.put("job-costs", row.key, row);
    rows.push(row);
  }
  const top = rows.filter((r) => r.parts_ex_gst > 0).sort((a, b) => b.parts_ex_gst - a.parts_ex_gst).slice(0, ctx.settings.top_jobs ?? 10);
  if (!top.length) { ctx.log(`cost-watch: ${rows.length} workshop jobs, none with parts yet`); return { jobs: rows.length, queued: 0 }; }
  const total = round(top.reduce((a, r) => a + r.parts_ex_gst, 0));
  const day = ctx.now.toISOString().slice(0, 10);
  await queueCostSummary(ctx, `cost-summary:${day}`, top, total); // keyed by day: a second run the same day queues nothing new
  ctx.log(`cost-watch: ${rows.length} workshop jobs, summary of ${top.length} queued`);
  return { jobs: rows.length, queued: 1 };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "register-watch": registerWatch,
  "cost-watch": costWatch,
};
