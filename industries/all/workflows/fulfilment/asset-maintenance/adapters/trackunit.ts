// Trackunit: the asset register, planned service status per asset, and failed inspection responses.
// Field names come from Trackunit's official OpenAPI spec (assets, service-management, inspections).
// Everything here is a read; the crons draft the jobs in ServiceM8, so nothing is written to Trackunit.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Asset, ID, DAY, clip, rows } from "../types.ts";

export const P = "trackunit" as const;
const read = async <T = any>(ctx: Ctx<Settings>, op: string, input: Record<string, unknown>) =>
  (await ctx.draft<T>({ platform: P, op, input: { params: input }, summary: `read ${op}` })).data;

/** Visible assets on the account, capped at the setting. Hidden assets are left out. */
export async function assets(ctx: Ctx<Settings>, now: Date): Promise<Asset[]> {
  const page = await read(ctx, "assets.getAssets_v2", { page: 0, size: ctx.settings.max_assets ?? 50 });
  return rows(page)
    .filter((a) => a && a.hidden !== true && ID.test(String(a.id ?? "")))
    .map((a): Asset => ({
      id: String(a.id), name: clip(a.name || a.serialNumber || a.id, 120), type: clip(a.type, 60) || undefined,
      brand: clip(a.brand, 60) || undefined, model: clip(a.model, 60) || undefined, serialNumber: clip(a.serialNumber, 60) || undefined,
      seen: now.toISOString(),
    }));
}

export interface PlannedService { plannedServiceId: string; servicePlanId: string; name: string; status: string; predictedServiceTime?: string }

/** Planned service items for one asset. Items Trackunit already shows as booked are left out. */
export async function plannedServices(ctx: Ctx<Settings>, assetId: string): Promise<PlannedService[]> {
  if (!ID.test(assetId)) throw new Error("trackunit: bad asset id");
  const d = await read(ctx, "service-management.GetPlannedServiceStatuses", { assetId });
  const list: any[] = Array.isArray(d?.plannedServiceStatuses) ? d.plannedServiceStatuses : [];
  return list
    .filter((s) => s && ID.test(String(s.plannedServiceId ?? "")) && ID.test(String(s.servicePlanId ?? "")) && s.booked !== true)
    .map((s) => ({ plannedServiceId: String(s.plannedServiceId), servicePlanId: String(s.servicePlanId), name: clip(s.name, 120) || "Planned service",
                   status: String(s.status ?? "UNKNOWN"), predictedServiceTime: s.predictedServiceTime ? String(s.predictedServiceTime) : undefined }));
}

export interface FailedResponse { id: string; assetId: string; critical: boolean; text: string }

/** Inspection responses that ended in a failed check in the last two hours. Status is filtered here, not in the query. */
export async function failedResponses(ctx: Ctx<Settings>, now: Date): Promise<FailedResponse[]> {
  const from = new Date(now.getTime() - 2 * 3600e3).toISOString();
  const d = await read(ctx, "inspections.getInspectionResponses", { endTimeFrom: from, size: 100, page: 0 });
  return rows(d)
    .filter((r) => r && ID.test(String(r.id ?? "")) && (r.status === "FAILED_CRITICAL" || r.status === "FAILED_LOW"))
    .map((r): FailedResponse => {
      const bad: any[] = (Array.isArray(r.answers) ? r.answers : []).filter((a) => a && (a.criticality === "FAILED_CRITICAL" || a.criticality === "FAILED_LOW"));
      const text = bad.map((a) => clip(`${a.answer ?? "failed"}${a.comment ? ` (${a.comment})` : ""}`, 240)).join("; ") || "Inspection failed";
      return { id: String(r.id), assetId: String(r.assetId ?? ""), critical: r.status === "FAILED_CRITICAL", text: clip(text, 500) };
    });
}

export const withinDays = (iso: string | undefined, now: Date, days: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t - now.getTime() <= days * DAY;
};
