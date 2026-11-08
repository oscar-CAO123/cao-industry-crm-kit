// The automatic time capture workflow's three crons. capture and matters only read and flag. entries queues a time entry
// a person recorded, and the approval is the only thing that writes it to Clio.
import { safeKey, type Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Flag, Matter, Request, Settings } from "./types.ts";
import { dayEntries, entryAct, openMatters, runningTimer, hours, day } from "./adapters/clio.ts";

const todayUtc = (now: Date) => now.toISOString().slice(0, 10);

/** Every 30 minutes: read today's time entries and the running timer. Flag each entry with no matter or no note. */
export async function capture(ctx: Ctx<Settings>) {
  const date = todayUtc(ctx.now);
  const entries = await dayEntries(ctx, date);
  const timer = await runningTimer(ctx);
  await ctx.store.put("captured", safeKey(`${ctx.settings.clio_user_id}:${date}`), { at: ctx.now.toISOString(), entries, timer });
  let flagged = 0;
  for (const e of entries) {
    const kinds: Flag["kind"][] = [];
    if (e.matter_id === null) kinds.push("no-matter");
    if (!e.note) kinds.push("no-note");
    for (const kind of kinds) {
      const key = safeKey(`${kind}:${e.id}`);
      if (await ctx.store.get("flags", key)) continue;   // a flag stays until a person clears it: no duplicates
      await ctx.store.put("flags", key, { key, kind, entry_id: e.id, date: e.date, raised: ctx.now.toISOString() } satisfies Flag);
      flagged++;
    }
  }
  ctx.log(`capture: ${entries.length} entries, timer ${timer ? "running" : "none"}, ${flagged} flagged`);
  return { entries: entries.length, timer_running: timer !== null, flagged };
}

/** Daily: read the matters a person can classify an entry to, and keep the list for entries cron to check against. */
export async function matters(ctx: Ctx<Settings>) {
  const rows = await openMatters(ctx);
  await ctx.store.put("matters", safeKey(`open:${ctx.settings.clio_user_id}`), { at: ctx.now.toISOString(), rows });
  ctx.log(`matters: ${rows.length} read`);
  return { matters: rows.length };
}

/** Every 15 minutes: take each time entry a person recorded, check its matter, and queue it for approval. */
export async function entries(ctx: Ctx<Settings>) {
  const open = Object.values(await ctx.store.list<Request>("requests")).filter((r) => r.status === "requested");
  if (open.length === 0) return { queued: 0, parked: 0 };
  const snapshot = await ctx.store.get<{ rows: Matter[] }>("matters", safeKey(`open:${ctx.settings.clio_user_id}`));
  const known = new Set((snapshot?.rows ?? (await openMatters(ctx))).map((m) => m.id));
  let queued = 0, parked = 0;
  for (const r of open) {
    const park = async (why: string) => { parked++; await ctx.store.put("requests", r.id, { ...r, status: "needs-check", reason_parked: why } satisfies Request); };
    try { day(r.date); hours(r.hours); } catch (e) { await park((e as Error).message); continue; }
    if (!known.has(Number(r.matter_id))) { await park(`matter ${r.matter_id} is not one of the open matters`); continue; }
    let act;
    try { act = entryAct(ctx, r); } catch (e) { await park((e as Error).message); continue; }
    await ctx.queue(act, act.summary);
    await ctx.store.put("requests", r.id, { ...r, status: "queued" } satisfies Request);
    queued++;
  }
  ctx.log(`entries: ${queued} queued, ${parked} parked`);
  return { queued, parked };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { capture, matters, entries };
