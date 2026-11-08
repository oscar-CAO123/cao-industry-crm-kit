// The settlement workflow's three crons. Each is deterministic: it reads, drafts internal calendar records and queues
// date changes for a person. The agreed date itself is judgment (read the contract or the solicitor's confirmation):
// the agent or a person writes it into the "agreed" store, see SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Agreed, type Matter, uuid, isDay, dayOf } from "./types.ts";
import { openMatters, settlementEvents, createSettlement, dateChangeAct, remindersOn, createReminder } from "./adapters/smokeball.ts";

/** Every 30 minutes: read the open matters and their settlement events into the register. Reads only. */
export async function register(ctx: Ctx<Settings>) {
  const matters = await openMatters(ctx);
  for (const m of matters) {
    const events = await settlementEvents(ctx, m.matter_id);
    await ctx.store.put("matters", m.matter_id, { matter_id: m.matter_id, status: m.status, events, seen: ctx.now.toISOString() } satisfies Matter);
  }
  ctx.log(`register: ${matters.length} open matters read`);
  return { matters: matters.length };
}

/** Every 30 minutes: compare each agreed date with the register. A missing event is drafted once; a changed date is queued. */
export async function check(ctx: Ctx<Settings>) {
  let created = 0, queued = 0, skipped = 0;
  for (const a of Object.values(await ctx.store.list<Agreed>("agreed"))) {
    let matterId: string;
    try { matterId = uuid(a.matter_id, "matter id"); } catch { skipped++; ctx.log("check: skipped a record with a bad matter id"); continue; }
    const day = isDay(a.date);
    if (!day) { skipped++; ctx.log(`check: ${matterId} has no valid agreed date`); continue; }
    const m = await ctx.store.get<Matter>("matters", matterId);
    if (!m) { skipped++; ctx.log(`check: ${matterId} is not in the register yet`); continue; }
    if (m.events.length > 1) { skipped++; ctx.log(`check: ${matterId} has ${m.events.length} settlement events: a person picks one`); continue; }
    if (m.events.length === 0) {
      // A settlement event this workflow already created is waiting for the register to see it: never create a second.
      if (a.event_id) { skipped++; ctx.log(`check: ${matterId} event ${a.event_id} is not in the register yet`); continue; }
      const id = await createSettlement(ctx, matterId, day);
      await ctx.store.put("agreed", matterId, { ...a, event_id: id } satisfies Agreed);
      created++;
      continue;
    }
    const e = m.events[0];
    if (a.event_id && a.event_id !== e.event_id) { skipped++; ctx.log(`check: ${matterId} settlement event is not the one this workflow made: a person checks it`); continue; }
    if (!a.event_id) await ctx.store.put("agreed", matterId, { ...a, event_id: e.event_id } satisfies Agreed);
    if (e.date === day) continue;
    await ctx.queue(dateChangeAct(ctx, e.event_id, matterId, day), `Move settlement on matter ${matterId} from ${e.date} to ${day} (source: ${a.source})`);
    queued++;
  }
  ctx.log(`check: ${created} created, ${queued} date changes queued, ${skipped} skipped`);
  return { created, queued, skipped };
}

/** Daily: one reminder per settlement still to come. Drafted on the matter's calendar; nothing until the reminder settings are set. */
export async function reminders(ctx: Ctx<Settings>) {
  if (!remindersOn(ctx.settings)) { ctx.log("reminders: reminder settings not set, nothing drafted"); return { drafted: 0, off: true }; }
  const today = dayOf(ctx.now);
  let drafted = 0;
  for (const m of Object.values(await ctx.store.list<Matter>("matters"))) {
    if (!ctx.settings.matter_status.includes(m.status ?? "")) continue;
    for (const e of m.events) {
      if (e.date < today || (await ctx.store.get("reminded", e.event_id))) continue;
      await createReminder(ctx, e.event_id);
      await ctx.store.put("reminded", e.event_id, { at: ctx.now.toISOString() });
      drafted++;
    }
  }
  ctx.log(`reminders: ${drafted} drafted`);
  return { drafted, off: false };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { register, check, reminders };
