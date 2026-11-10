// Trackunit: planned services and device issues per vehicle (draft reads), and the workshop booking (a live operation, queued only).
// Field names come from the vendor spec: service-management (GetPlannedServiceStatusesResponse, MakeBookingRequest) and
// device-health-issues (PaginatedIssue).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { PlannedService, Settings } from "../types.ts";

export const P = "trackunit";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const STATUSES = new Set(["OVERDUE", "UPCOMING", "PLANNED", "UNKNOWN"]);

/** A vehicle or service id from outside: checked before it goes into a path or a body. */
export function checkId(v: unknown, what: string): string {
  const s = String(v ?? "");
  if (!ID.test(s)) throw new Error(`trackunit: bad ${what} id`);
  return s;
}

/** Planned services for one vehicle (draft read). */
export async function plannedServices(ctx: Ctx<Settings>, asset: string): Promise<PlannedService[]> {
  const params: Record<string, unknown> = { assetId: asset };
  if (ctx.settings.system_of_measurement) params.systemOfMeasurement = ctx.settings.system_of_measurement;
  const r = await ctx.draft<{ plannedServiceStatuses?: { plannedServiceId?: unknown; servicePlanId?: unknown; status?: unknown }[] }>({
    platform: P, op: "service-management.GetPlannedServiceStatuses", summary: `planned services for vehicle ${asset}`, input: { params },
  });
  const out: PlannedService[] = [];
  for (const s of r.data?.plannedServiceStatuses ?? []) {
    if (typeof s.plannedServiceId !== "string" || typeof s.servicePlanId !== "string") continue;
    if (!ID.test(s.plannedServiceId) || !ID.test(s.servicePlanId)) continue;
    const status = typeof s.status === "string" && STATUSES.has(s.status) ? (s.status as PlannedService["status"]) : "UNKNOWN";
    out.push({ plannedServiceId: s.plannedServiceId, servicePlanId: s.servicePlanId, status });
  }
  return out;
}

/** Open device health issues for one vehicle (draft read). */
export async function openIssues(ctx: Ctx<Settings>, asset: string): Promise<number> {
  const r = await ctx.draft<{ totalElements?: unknown; content?: unknown[] }>({
    platform: P, op: "device-health-issues.getIssuesByAsset", summary: `device issues for vehicle ${asset}`, input: { params: { assetId: asset } },
  });
  const total = r.data?.totalElements;
  return typeof total === "number" ? total : (r.data?.content ?? []).length;
}

/** A workshop booking for one planned service. Live: it is only ever queued, and runs when a person approves it. */
export function bookingAct(asset: string, plannedServiceId: string): Act {
  return {
    platform: P, op: "service-management.MakeBooking", key: `book-${asset}-${plannedServiceId}`,
    summary: `book planned service ${plannedServiceId} for vehicle ${asset}`,
    input: { body: { assetId: asset, plannedServiceId } },
  };
}
