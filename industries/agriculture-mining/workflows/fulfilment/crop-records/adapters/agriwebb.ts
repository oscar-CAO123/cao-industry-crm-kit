// AgriWebb: reads for the season record, and one queued write (rainfall). Field names from AgriWebb's official schema:
// Farm { id name timeZone }, Field { id name farmId totalArea unit landUse cropType }, Session, Record { recordId recordType
// observationDate sessionId }, AnimalsWithCount { nonPagedCount }, Rainfall, AddRainfallInput. Every read is a draft
// operation; addRainfalls is a live operation and only ever runs after a person approves it.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Farm, type Field, type Session, type Rainfall, type RainProposal, DAY, FARM } from "../types.ts";

const P = "agriwebb";
const FIELD_SELECT = "id name farmId totalArea unit landUse cropType lastModifiedDate";
const SESSION_SELECT = "id name type state farmId";
const RECORD_SELECT = "recordId recordType observationDate sessionId";
const RAIN_SELECT = "id value unit sensorId time mode farmId";

/** The farms to watch: the configured farm_ids, or every farm the token can see. Ids that fail the plain-id check are dropped. */
export async function listFarms(ctx: Ctx<Settings>): Promise<Farm[]> {
  const r = await ctx.draft<{ data?: { farms?: Farm[] } }>({ platform: P, op: "query.farms", summary: "read farms", input: { select: "id name timeZone" } });
  const rows = Array.isArray(r.data?.data?.farms) ? r.data!.data!.farms! : [];
  const wanted = ctx.settings.farm_ids?.length ? rows.filter((f) => ctx.settings.farm_ids!.includes(f.id)) : rows;
  return wanted.filter((f) => FARM.test(String(f.id ?? ""))).slice(0, 5);
}

/** One farm's season read. The six reads are independent, so they run at once. */
export async function readFarm(ctx: Ctx<Settings>, farmId: string, recordSinceMs: number, rainSinceMs: number) {
  const [fields, sessions, records, animals, rain] = await Promise.all([
    ctx.draft<{ data?: { fields?: Field[] } }>({ platform: P, op: "query.fields", summary: "read fields",
      input: { params: { filter: { farmId: { _eq: farmId } }, limit: 500 }, select: FIELD_SELECT } }),
    ctx.draft<{ data?: { sessions?: Session[] } }>({ platform: P, op: "query.sessions", summary: "read sessions",
      input: { params: { farmId, limit: 50 }, select: SESSION_SELECT } }),
    ctx.draft<{ data?: { records?: unknown[] } }>({ platform: P, op: "query.records", summary: "read recent records",
      input: { params: { options: { farmId, limit: 50, filter: { observationDate: { _gte: recordSinceMs } } } }, select: RECORD_SELECT } }),
    ctx.draft<{ data?: { animalsWithCount?: { nonPagedCount?: number } } }>({ platform: P, op: "query.animalsWithCount", summary: "count animals",
      input: { params: { farmId, limit: 1 }, select: "nonPagedCount" } }),
    ctx.draft<{ data?: { rainfalls?: Rainfall[] } }>({ platform: P, op: "query.rainfalls", summary: "read rainfall",
      input: { params: { filter: { farmId: { _eq: farmId }, time: { _gte: rainSinceMs } }, limit: 200 }, select: RAIN_SELECT } }),
  ]);
  const list = <T,>(x: { data?: Record<string, unknown> }, k: string): T[] => {
    const v = x.data?.data?.[k];
    return Array.isArray(v) ? (v as T[]) : [];
  };
  return {
    fields: list<Field>(fields, "fields"),
    sessions: list<Session>(sessions, "sessions"),
    recent_records: list<unknown>(records, "records").length,
    animals: (animals.data?.data as any)?.animalsWithCount?.nonPagedCount as number | undefined,
    rainfall: list<Rainfall>(rain, "rainfalls"),
  };
}

/** The rainfall write as an approval item. The key makes a re-run of the queue cron queue the same reading once. */
export function rainfallAct(p: RainProposal, key: string): Act {
  const row = { farmId: p.farm_id, sensorId: p.sensor_id, value: p.value, unit: "mm", time: p.time, mode: p.mode ?? "absolute" };
  return {
    platform: P, op: "mutation.addRainfalls", key,
    summary: `add ${p.value} mm rainfall on farm ${p.farm_id} from gauge ${p.sensor_id}`,
    input: { params: { input: [row] }, select: "rainfalls { id value time }" },
  };
}
