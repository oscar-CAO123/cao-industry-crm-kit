// Smokeball: open matters, settlement calendar events on each matter, and their reminders.
// Field names come from Smokeball's official spec (EventDto, ReminderDto, the Event and Matter responses).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ApiError } from "../../../../../../core/lib/http.ts";
import { uuid, isDay, dayOf, addDays, type Settings, type SettlementEvent } from "../types.ts";

const P = "smokeball";
const valuesOf = (r: { data?: unknown }): any[] => {
  const v = (r.data as any)?.value;
  return Array.isArray(v) ? v : [];
};

/** Open matters, read only: one request per status, because the call layer sends arrays as JSON and Smokeball reads one value.
 *  Ids that are not real ids are dropped before they reach any path. */
export async function openMatters(ctx: Ctx<Settings>): Promise<{ matter_id: string; status: string }[]> {
  const s = ctx.settings;
  const found = new Map<string, string>();
  for (const status of s.matter_status) {
    if (!/^[A-Za-z]{1,20}$/.test(status)) throw new Error("settlement: bad matter status in settings");
    const r = await ctx.draft({ platform: P, op: "GetMatters", summary: `read ${status} matters`,
      input: { params: { Status: status, Limit: s.max_matters } } });
    for (const m of valuesOf(r)) {
      try { found.set(uuid(m.id, "matter id"), String(m.status ?? status)); } catch { /* not a real id: skip */ }
    }
  }
  return [...found].map(([matter_id, status]) => ({ matter_id, status }));
}

/** The settlement events on one matter, from today to the horizon. Read only. */
export async function settlementEvents(ctx: Ctx<Settings>, matterId: string): Promise<SettlementEvent[]> {
  const s = ctx.settings;
  const r = await ctx.draft({ platform: P, op: "GetEvents", summary: `read events on matter ${matterId}`,
    input: { params: { MatterId: matterId, From: dayOf(ctx.now), To: dayOf(addDays(ctx.now, s.horizon_days)), ExcludeDeletedEvents: true, Limit: 50 } } });
  const word = s.settlement_subject.toLowerCase();
  const out: SettlementEvent[] = [];
  for (const e of valuesOf(r)) {
    const date = isDay(String(e.startTime ?? "").slice(0, 10));
    if (!date || e.isDeleted || !String(e.subject ?? "").toLowerCase().includes(word)) continue;
    if (e.matter && String(e.matter.id ?? "") !== matterId) continue;
    try { out.push({ event_id: uuid(e.id, "event id"), date, subject: String(e.subject).slice(0, 200) }); } catch { /* not a real event id: skip */ }
  }
  return out;
}

/** One settlement event read by its id, whatever its date, read only. Undefined when it is gone, deleted, or no longer a
 *  settlement on this matter. Used when the register window (today to the horizon) cannot see the event any more. */
export async function settlementEventById(ctx: Ctx<Settings>, matterId: string, eventId: string): Promise<SettlementEvent | undefined> {
  const id = uuid(eventId, "event id");
  let e: any;
  try {
    e = (await ctx.draft({ platform: P, op: "GetEventById", summary: `read settlement event ${id}`, input: { params: { eventId: id } } })).data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined;
    throw err;
  }
  const date = isDay(String(e?.startTime ?? "").slice(0, 10));
  if (!date || e.isDeleted || !String(e.subject ?? "").toLowerCase().includes(ctx.settings.settlement_subject.toLowerCase())) return undefined;
  if (e.matter && String(e.matter.id ?? "") !== matterId) return undefined;
  return { event_id: id, date, subject: String(e.subject).slice(0, 200) };
}

/** The EventDto for a settlement: an all-day, non-billable event on the matter with no attendees, so nothing invites anyone. */
export const eventBody = (s: Settings, matterId: string, date: string) => ({
  matterId,
  subject: s.settlement_subject,
  description: "Settlement date agreed with the solicitors. Check it against the signed contract.",
  allDay: true,
  nonBillable: true,
  startTime: `${date}T00:00:00`,
  endTime: `${date}T23:59:59`,
  timeZone: s.time_zone,
  attendees: [] as string[],
  externalAttendees: [] as string[],
});

/** Draft: a new settlement event on the matter's calendar. Returns its id. */
export async function createSettlement(ctx: Ctx<Settings>, matterId: string, date: string): Promise<string> {
  const r = await ctx.draft({ platform: P, op: "CreateEvent", summary: `settlement ${date} on matter ${matterId}`,
    input: { body: eventBody(ctx.settings, matterId, date) } });
  return uuid((r.data as any)?.id, "created event id");
}

/** Live: move an existing settlement event to a new date. Queued for a person; the key stops a repeat queue. */
export function dateChangeAct(ctx: Ctx<Settings>, eventId: string, matterId: string, date: string) {
  return { platform: P, op: "UpdateEvent", key: `settle:${eventId}:${date}`, summary: `move settlement on matter ${matterId} to ${date}`,
    input: { params: { eventId }, body: eventBody(ctx.settings, matterId, date) } };
}

/** Reminders are only drafted once the firm has set the offset type and staff ids. */
export function remindersOn(s: Settings): boolean {
  return !!s.reminder && s.reminder.offset_type_id > 0 && !!s.reminder.offset_type && s.reminder.user_ids.length > 0;
}

/** Draft: one reminder on a settlement event, offset by remind_days. */
export async function createReminder(ctx: Ctx<Settings>, eventId: string): Promise<void> {
  const rm = ctx.settings.reminder!;
  await ctx.draft({ platform: P, op: "CreateReminder", summary: `reminder ${ctx.settings.remind_days} days before settlement ${eventId}`,
    input: { params: { eventId: uuid(eventId, "event id") },
      body: { offset: ctx.settings.remind_days, offsetTypeId: rm.offset_type_id, offsetType: rm.offset_type, isAllDayReminder: true,
              userIds: rm.user_ids.map((u) => uuid(u, "user id")) } } });
}
