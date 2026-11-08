// The carbon-credits workflow's two crons. Both only read: snapshot reads AgriWebb, checklist reads the store.
// Nothing is queued, because no live operation is mapped for carbon registration, claims, sales or payment.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, Snapshot, ChecklistDraft, ChecklistItem, FarmSnapshot } from "./types.ts";
import { farmId, farms as readFarms, fields as readFields, records as readRecords } from "./adapters/agriwebb.ts";

/** Daily: read each configured farm's fields and records from AgriWebb and keep them as evidence. */
export async function snapshot(ctx: Ctx<Settings>) {
  const ids = (ctx.settings.farms ?? []).map(farmId);
  if (!ids.length) throw new Error("carbon-credits: settings.farms is empty");
  const known = await readFarms(ctx, ids);
  const out: FarmSnapshot[] = [];
  for (const id of ids) {
    const f = known.find((x) => x.id === id);
    const fields = await readFields(ctx, id);
    const records = await readRecords(ctx, id);
    out.push({
      farm: id,
      name: f?.name ?? undefined,
      time_zone: f?.timeZone ?? undefined,
      fields: fields.map((x) => ({
        id: String(x.id ?? ""),
        name: x.name ?? undefined,
        total_area: typeof x.totalArea === "number" ? x.totalArea : undefined,
        unit: x.unit ?? undefined,
        land_use: x.landUse ?? undefined,
        crop_type: x.cropType ?? undefined,
      })),
      records_count: records.length,
    });
  }
  const snap: Snapshot = { taken: ctx.now.toISOString(), farms: out };
  await ctx.store.put("evidence", "latest", snap);
  ctx.log(`snapshot: ${out.length} farms`);
  return { farms: out.length };
}

/** Weekly: draft the carbon checklist from the latest snapshot. Reads the store only, never the platform. */
export async function checklist(ctx: Ctx<Settings>) {
  const snap = await ctx.store.get<Snapshot>("evidence", "latest");
  if (!snap) return { drafted: 0, reason: "no snapshot yet" };
  const farms = snap.farms.map((f): { farm: string; items: ChecklistItem[] } => {
    const n = f.fields.length;
    const withArea = f.fields.filter((x) => typeof x.total_area === "number" && x.total_area > 0).length;
    const withLand = f.fields.filter((x) => x.land_use).length;
    const level = (count: number) => (n === 0 || count === 0 ? "missing" : count === n ? "on file" : "partial") as ChecklistItem["status"];
    return {
      farm: f.farm,
      items: [
        { item: "Farm profile", status: f.name ? "on file" : "missing", detail: f.name ? f.name : "no farm name in AgriWebb" },
        { item: "Field boundaries and areas", status: level(withArea), detail: `${withArea} of ${n} fields have an area` },
        { item: "Land use per field", status: level(withLand), detail: `${withLand} of ${n} fields have a land use` },
        { item: "Farm records in the system", status: f.records_count > 0 ? "on file" : "missing", detail: `${f.records_count} records read (up to 500)` },
      ],
    };
  });
  const draft: ChecklistDraft = { snapshot: snap.taken, farms };
  await ctx.store.put("drafts", "carbon-checklist", draft);
  ctx.log(`checklist: ${farms.length} farms drafted`);
  return { drafted: farms.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { snapshot, checklist };
