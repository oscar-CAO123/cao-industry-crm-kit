// Calendly: the appointment book. Reads scheduled events and their invitees (draft operations), and a no-show mark
// (a live operation: a person approves it). Field names come from Calendly's official spec in
// endpoint-map/raw/calendly/spec: a list returns {collection, pagination}; an event has uri, start_time, end_time, name;
// an invitee has uri, email, name, status and no_show; the no-show body is {invitee: <invitee uri>}.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, EMAIL, EVENT_URI, INVITEE_URI, text } from "../types.ts";

const P = "calendly" as const;
export const READ_EVENTS = "api.scheduledEvents_list-scheduled-events";
export const READ_INVITEES = "api.scheduledEvents_list-event-invitees";
export const NO_SHOW = "api.scheduledEvents_create-invitee-no-show";

export interface Event { uuid: string; name: string; starts: string; ends: string }
export interface Invitee { uuid: string; invitee: string; event: string; name?: string; email?: string; status: "active" | "canceled"; no_show?: string }

/** Active events that start inside the window. One page, at most 100. */
export async function eventsBetween(ctx: Ctx<Settings>, userUri: string, from: string, to: string): Promise<Event[]> {
  const r = await ctx.draft<{ collection?: any[] }>({ platform: P, op: READ_EVENTS, summary: "read scheduled events",
    input: { params: { user: userUri, status: "active", min_start_time: from, max_start_time: to, count: 100 } } });
  const out: Event[] = [];
  for (const e of r.data?.collection ?? []) {
    const m = EVENT_URI.exec(String(e?.uri ?? ""));
    const starts = Date.parse(e?.start_time), ends = Date.parse(e?.end_time);
    if (!m || !Number.isFinite(starts) || !Number.isFinite(ends)) continue;
    out.push({ uuid: m[1], name: text(e.name, 120), starts: new Date(starts).toISOString(), ends: new Date(ends).toISOString() });
  }
  return out;
}

/** The invitees of one event. An invitee whose URI does not belong to this event is dropped. */
export async function inviteesOf(ctx: Ctx<Settings>, eventUuid: string): Promise<Invitee[]> {
  const r = await ctx.draft<{ collection?: any[] }>({ platform: P, op: READ_INVITEES, summary: "read invitees",
    input: { params: { uuid: eventUuid, count: 100 } } });
  const out: Invitee[] = [];
  for (const i of r.data?.collection ?? []) {
    const m = INVITEE_URI.exec(String(i?.uri ?? ""));
    if (!m || m[1] !== eventUuid) continue;
    const name = text(i.name ?? [i.first_name, i.last_name].filter(Boolean).join(" "), 120);
    out.push({
      uuid: m[2], invitee: String(i.uri), event: eventUuid,
      name: name || undefined,
      email: EMAIL.test(String(i.email ?? "")) ? String(i.email) : undefined,
      status: i.status === "canceled" ? "canceled" : "active",
      no_show: typeof i.no_show?.uri === "string" ? i.no_show.uri : undefined,
    });
  }
  return out;
}
