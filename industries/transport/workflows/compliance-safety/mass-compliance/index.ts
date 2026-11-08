// The mass compliance workflow's two crons. Both are deterministic: register reads the vehicle register, and
// mass-check queues a note for approval on each vehicle missing a field a vehicle chart needs. Neither writes to Trackunit.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { readRegister, noteAct } from "./adapters/trackunit.ts";
import { DEFAULT_REQUIRED, VEHICLE_FIELDS, type Settings, type VehicleField, type VehicleRecord } from "./types.ts";

/** Every 6 hours: read the vehicle register into the workflow store. Reads only. */
export async function register(ctx: Ctx<Settings>) {
  const vehicles = await readRegister(ctx);
  for (const v of vehicles) await ctx.store.put("vehicles", v.id, v);
  ctx.log(`register: ${vehicles.length} vehicles`);
  return { vehicles: vehicles.length };
}

/** Every 6 hours, 30 minutes after register: queue one note per vehicle missing a required field. Queues only. */
export async function massCheck(ctx: Ctx<Settings>) {
  const known = new Set<string>(VEHICLE_FIELDS);
  const need = (ctx.settings.required_fields ?? DEFAULT_REQUIRED).filter((f): f is VehicleField => known.has(f));
  const vehicles = Object.values(await ctx.store.list<VehicleRecord>("vehicles"));
  let flagged = 0, clear = 0;
  for (const v of vehicles) {
    const missing = need.filter((f) => v[f] === undefined || v[f] === "");
    if (!missing.length) { clear++; continue; }
    const note = `Mass check: the register is missing ${missing.join(", ")}. Add these before the next compliance review.`;
    await ctx.queue(noteAct(v.id, note, safeKey(`mass-note.${v.id}.${missing.join(",")}`)), `Note on ${v.name || v.id}: missing ${missing.join(", ")}`);
    flagged++;
  }
  ctx.log(`mass-check: ${flagged} flagged, ${clear} clear`);
  return { flagged, clear };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { register, "mass-check": massCheck };
