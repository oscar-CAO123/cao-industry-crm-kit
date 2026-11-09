// The crop and livestock records workflow's three crons. collect and review read AgriWebb and the local store and
// draft; queue-records only queues a rainfall write. Nothing here writes to AgriWebb on a cron (see SKILL.md).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Snapshot, type RainProposal, type ReviewDraft, DAY, SENSOR, FARM, keyOf, toMs } from "./types.ts";
import { listFarms, readFarm, rainfallAct } from "./adapters/agriwebb.ts";

/** Every 30 minutes: read each watched farm's fields, sessions, recent records, animal count and rainfall into the store. */
export async function collect(ctx: Ctx<Settings>) {
  const now = ctx.now.getTime();
  const recordSince = now - (ctx.settings.stale_days ?? 14) * DAY;
  const rainSince = now - (ctx.settings.rain_window_days ?? 30) * DAY;
  const farms = await listFarms(ctx);
  for (const farm of farms) {
    const r = await readFarm(ctx, farm.id, recordSince, rainSince);
    await ctx.store.put("snapshots", keyOf(farm.id), { farm, read: ctx.now.toISOString(), ...r } satisfies Snapshot);
  }
  ctx.log(`collect: ${farms.length} farms`);
  return { farms: farms.length };
}

/** Daily at 22:00 UTC (8 or 9 am in eastern Australia): flag what the season record is missing, from the last read. */
export async function review(ctx: Ctx<Settings>) {
  const stale = ctx.settings.stale_days ?? 14, rainDays = ctx.settings.rain_window_days ?? 30;
  const made = ctx.now.toISOString();
  let flagged = 0;
  for (const s of Object.values(await ctx.store.list<Snapshot>("snapshots"))) {
    const flags: string[] = [];
    if (s.recent_records === 0) flags.push(`No farm record dated in the last ${stale} days.`);
    const bare = s.fields.filter((f) => !f.cropType && !f.landUse).map((f) => f.name ?? f.id);
    if (bare.length) flags.push(`No crop type or land use set on: ${bare.slice(0, 20).join(", ")}.`);
    if (!s.rainfall.length) flags.push(`No rainfall reading in the last ${rainDays} days.`);
    const d: ReviewDraft = { farm_id: s.farm.id, farm_name: s.farm.name, made, flags, fields: s.fields.length, sessions: s.sessions.length, animals: s.animals };
    await ctx.store.put("reviews", keyOf(`${s.farm.id}:${made.slice(0, 10)}`), d);
    if (flags.length) flagged++;
  }
  ctx.log(`review: ${flagged} farms with flags`);
  return { farms_flagged: flagged };
}

/** Why a rainfall proposal is refused before it reaches the queue, or undefined when it is fine. */
function refusal(p: RainProposal, now: number, watched: Set<string>, read: Set<string>): string | undefined {
  if (p.kind !== "rainfall") return "unknown kind";
  if (!FARM.test(String(p.farm_id ?? ""))) return "farm id is not a plain id";
  if (watched.size && !watched.has(p.farm_id)) return "farm is not in farm_ids";
  if (!read.has(p.farm_id)) return "farm was not read by collect";
  if (!SENSOR.test(String(p.sensor_id ?? ""))) return "sensor id is not a plain id";
  if (!(typeof p.value === "number" && Number.isFinite(p.value) && p.value >= 0 && p.value <= 500)) return "value must be 0 to 500 mm";
  if (!(typeof p.time === "number" && p.time >= now - 400 * DAY && p.time <= now + DAY)) return "time must be within the last 400 days and at most a day ahead";
  if (p.mode !== undefined && p.mode !== "absolute" && p.mode !== "cumulative") return "mode must be absolute or cumulative";
  return undefined;
}

/** Every 30 minutes: queue each new rainfall proposal for approval. Nothing is written to AgriWebb until a person approves it. */
export async function queueRecords(ctx: Ctx<Settings>) {
  const now = ctx.now.getTime();
  const watched = new Set(ctx.settings.farm_ids ?? []);
  // Only farms that collect actually read (with farm_ids empty, the five farms the token could see) may be written to.
  const read = new Set(Object.values(await ctx.store.list<Snapshot>("snapshots")).map((s) => s.farm.id));
  let queued = 0, refused = 0;
  for (const [key, p] of Object.entries(await ctx.store.list<RainProposal>("proposals"))) {
    if (p.status && p.status !== "new") continue;
    const why = refusal(p, now, watched, read);
    if (why) { refused++; await ctx.store.put("proposals", key, { ...p, status: "refused", reason: why }); continue; }
    const approval = await ctx.queue(rainfallAct(p, keyOf(`rain:${p.farm_id}:${p.sensor_id}:${toMs(p.time)}:${p.value}`)));
    await ctx.store.put("proposals", key, { ...p, status: "queued", approval });
    queued++;
  }
  ctx.log(`queue-records: ${queued} queued, ${refused} refused`);
  return { queued, refused };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { collect, review, "queue-records": queueRecords };
