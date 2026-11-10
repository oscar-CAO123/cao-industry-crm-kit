// The settlement workflow's three crons. Each is deterministic: it reads, drafts internal calendar records and queues
// date changes for a person. The agreed date itself is judgment (read the contract or the solicitor's confirmation):
// the agent or a person writes it into the "agreed" store, see SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Agreed, type Matter, type Discrepancy, uuid, isDay, dayOf, clean, addDays } from "./types.ts";
import { contracts as rexContracts, contractStatuses } from "./adapters/rex.ts";
import { openMatters, settlementEvents, settlementEventById, createSettlement, dateChangeAct, remindersOn, createReminder } from "./adapters/smokeball.ts";

const platform = (ctx: Ctx<Settings>) => {
  const p = ctx.settings.platform ?? "smokeball";
  if (p !== "smokeball" && p !== "rex") throw new Error("settlement: platform must be smokeball or rex");
  return p;
};

/** Rex: read the contracts still to settle into the register. A contract is a matter; its one event is the expected settlement date. Reads only. */
async function rexRegister(ctx: Ctx<Settings>) {
  const watch = contractStatuses(ctx);
  let n = 0;
  const current: Record<string, Matter> = {};
  for (const c of await rexContracts(ctx)) {
    if (c.settled || !watch.includes(c.status)) continue;
    const matter = { matter_id: c.id, status: c.status, events: c.expected ? [{ event_id: c.id, date: c.expected, subject: "Settlement (expected, from the Rex contract)" }] : [], seen: ctx.now.toISOString() } satisfies Matter;
    current[c.id] = matter;
    await ctx.store.put("matters", c.id, matter);
    n++;
  }
  await ctx.store.put("rex-register", "current", current);
  ctx.log(`register: ${n} Rex contracts read`);
  return { matters: n };
}

/** Rex: an agreed date that differs from the contract's expected settlement date is flagged once per date pair. Nothing is written to Rex. */
async function rexCheck(ctx: Ctx<Settings>) {
  await rexRegister(ctx);
  const current = (await ctx.store.get<Record<string, Matter>>("rex-register", "current"))!;
  let flagged = 0, skipped = 0;
  for (const a of Object.values(await ctx.store.list<Agreed>("agreed"))) {
    const id = String(a.matter_id ?? ""), day = isDay(a.date);
    if (!/^[1-9]\d{0,11}$/.test(id) || !day) { skipped++; ctx.log("check: skipped a record with a bad contract id or date"); continue; }
    const m = current[id];
    if (!m) { skipped++; ctx.log(`check: contract ${id} is not in the register (settled, or not a watched status)`); continue; }
    const rex = m.events[0]?.date;
    if (rex === day) continue;
    const key = `${id}:${day}:${rex ?? "none"}`;
    if (await ctx.store.get("discrepancies", key)) continue;
    await ctx.store.put("discrepancies", key, { contract_id: id, agreed: day, rex, flagged: ctx.now.toISOString() } satisfies Discrepancy);
    ctx.log(`check: contract ${id}: agreed ${day}, Rex says ${rex ?? "no expected date"}; a person changes it in Rex (source: ${clean(a.source, 120)})`);
    flagged++;
  }
  ctx.log(`check: ${flagged} flagged, ${skipped} skipped`);
  return { created: 0, queued: 0, flagged, skipped };
}

/** Rex: list the contracts settling within remind_days, once each. A list for the team, kept in the store; nothing is written to Rex. */
async function rexReminders(ctx: Ctx<Settings>) {
  await rexRegister(ctx);
  const current = (await ctx.store.get<Record<string, Matter>>("rex-register", "current"))!;
  const today = dayOf(ctx.now), until = dayOf(addDays(ctx.now, Math.max(0, Number(ctx.settings.remind_days ?? 3))));
  const due: string[] = [];
  for (const m of Object.values(current)) {
    const e = m.events[0];
    if (!e || e.date < today || e.date > until || (await ctx.store.get("reminded", `rex-${m.matter_id}-${e.date}`))) continue;
    await ctx.store.put("reminded", `rex-${m.matter_id}-${e.date}`, { at: ctx.now.toISOString() });
    due.push(`${m.matter_id}:${e.date}`);
  }
  await ctx.store.put("settlement-due", "latest", { generated: ctx.now.toISOString(), due });
  ctx.log(`reminders: ${due.length} Rex contracts settling within the window`);
  return { drafted: 0, off: false, due: due.length };
}

/** Every 30 minutes: read the open matters and their settlement events into the register. Reads only. */
export async function register(ctx: Ctx<Settings>) {
  if (platform(ctx) === "rex") return rexRegister(ctx);
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
  if (platform(ctx) === "rex") return rexCheck(ctx);
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
      // An event this workflow already made or pinned is outside the register window (past the horizon, or deleted):
      // read it by id, so a date change is still queued, and never create a second one.
      if (a.event_id) {
        const ev = await settlementEventById(ctx, matterId, a.event_id);
        if (!ev) { skipped++; ctx.log(`check: ${matterId} event ${a.event_id} is gone or not a settlement on this matter: a person checks it`); continue; }
        if (ev.date === day) continue;
        await ctx.queue(dateChangeAct(ctx, ev.event_id, matterId, day), `Move settlement on matter ${matterId} from ${ev.date} to ${day} (source: ${clean(a.source, 120)})`);
        queued++;
        continue;
      }
      const id = await createSettlement(ctx, matterId, day);
      await ctx.store.put("agreed", matterId, { ...a, event_id: id } satisfies Agreed);
      created++;
      continue;
    }
    const e = m.events[0];
    if (a.event_id && a.event_id !== e.event_id) { skipped++; ctx.log(`check: ${matterId} settlement event is not the one this workflow made: a person checks it`); continue; }
    if (!a.event_id) await ctx.store.put("agreed", matterId, { ...a, event_id: e.event_id } satisfies Agreed);
    if (e.date === day) continue;
    await ctx.queue(dateChangeAct(ctx, e.event_id, matterId, day), `Move settlement on matter ${matterId} from ${e.date} to ${day} (source: ${clean(a.source, 120)})`);
    queued++;
  }
  ctx.log(`check: ${created} created, ${queued} date changes queued, ${skipped} skipped`);
  return { created, queued, skipped };
}

/** Daily: one reminder per settlement still to come. Drafted on the matter's calendar; nothing until the reminder settings are set. */
export async function reminders(ctx: Ctx<Settings>) {
  if (platform(ctx) === "rex") return rexReminders(ctx);
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
