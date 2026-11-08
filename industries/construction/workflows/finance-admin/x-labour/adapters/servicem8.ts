// ServiceM8: the staff clock-on, clock-off and lunch events for a pay period. Read only.
// Field names from ServiceM8's official spec: StaffTimeEvent (uuid, staff_uuid, timestamp, event_name, active).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Shift, GUID, nextDay } from "../types.ts";

const P = "servicem8";
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const EVENTS = new Set(["CLOCK_ON", "CLOCK_OFF", "LUNCH_START", "LUNCH_END"]);

export interface StaffEvent { uuid: string; staff: string; timestamp: string; event: string }
export interface Pairing { shifts: Shift[]; open: string[]; problem: string[] }

/** Every clock event in the pay period. Rows that do not check out are counted, never guessed at. */
export async function staffEvents(ctx: Ctx<Settings>, p: { start: string; end: string }): Promise<{ events: StaffEvent[]; bad: number }> {
  const from = `${p.start} 00:00:00`, to = `${nextDay(p.end)} 00:00:00`;
  const r = await ctx.draft<any[]>({ platform: P, op: "servicem8-api.listStaffTimeEvents", summary: "read staff clock events for the pay period",
    input: { params: { $filter: `timestamp gt '${from}' and timestamp lt '${to}' and active eq 1` } } });
  const events: StaffEvent[] = [];
  let bad = 0;
  for (const x of Array.isArray(r.data) ? r.data : []) {
    const e = { uuid: String(x?.uuid ?? ""), staff: String(x?.staff_uuid ?? ""), timestamp: String(x?.timestamp ?? ""), event: String(x?.event_name ?? "") };
    if (!GUID.test(e.uuid) || !GUID.test(e.staff) || !STAMP.test(e.timestamp) || !EVENTS.has(e.event)) bad++;
    else events.push(e);
  }
  return { events, bad };
}

const ms = (ts: string) => Date.parse(`${ts.replace(" ", "T")}Z`);

/** Pairs each person's clock-on with the next clock-off, less lunch. A person whose events do not pair writes no shifts from
 *  that run, and is reported as a problem. A clock-on still open at the end is reported as open. Nothing is guessed. */
export function shiftsFrom(events: StaffEvent[]): Pairing {
  const byStaff = new Map<string, StaffEvent[]>();
  for (const e of events) byStaff.set(e.staff, [...(byStaff.get(e.staff) ?? []), e]);
  const out: Pairing = { shifts: [], open: [], problem: [] };
  for (const [staff, list] of byStaff) {
    const seq = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.uuid.localeCompare(b.uuid));
    const done: Shift[] = [];
    let on: StaffEvent | null = null, lunch: StaffEvent | null = null, lunchMs = 0, bad = false;
    for (const e of seq) {
      if (e.event === "CLOCK_ON") {
        if (on) bad = true;
        on = e; lunch = null; lunchMs = 0;
      } else if (e.event === "LUNCH_START") {
        if (!on || lunch) bad = true;
        else lunch = e;
      } else if (e.event === "LUNCH_END") {
        if (!on || !lunch) bad = true;
        else { lunchMs += ms(e.timestamp) - ms(lunch.timestamp); lunch = null; }
      } else if (e.event === "CLOCK_OFF") {
        if (!on || lunch) bad = true;
        else {
          const hours = Math.round(((ms(e.timestamp) - ms(on.timestamp) - lunchMs) / 36e5) * 100) / 100;
          if (hours > 0) done.push({ key: on.uuid, staff, date: on.timestamp.slice(0, 10), hours });
          else bad = true;
        }
        on = null; lunch = null; lunchMs = 0;
      }
    }
    if (on) out.open.push(staff);
    if (bad) out.problem.push(staff);
    else out.shifts.push(...done);
  }
  return out;
}
