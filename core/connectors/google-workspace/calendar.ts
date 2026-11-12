// Google Calendar helper: list events, check free and busy time, and create events. Creating an
// event sends no invitations unless the caller asks.
//
// Source, from the reference CRM at commit 28aa5d91 unless marked NEW:
//   listEvents         lib/google-calendar.ts listEventsInRange and normaliseEvent. Changed on purpose: untitled
//                      events are kept (busy time), and a list too long to finish throws instead of stopping at 2,500.
//   createEvent        lib/google-calendar.ts createClientZoomEvent (one meeting link, conferencing off, auto-Meet stripped)
//   cancelEvent        lib/google-calendar.ts cancelClientZoomEvent (404 and 410 count as cancelled)
//   freeBusy           NEW: from Google's Calendar docs, not yet run in production

import { call } from "../../lib/http.ts";
import { collect } from "../../lib/paging.ts";
import { authHeaders, SCOPES, spec } from "./auth.ts";

const API = "https://www.googleapis.com/calendar/v3";

export interface CalEvent {
  id: string; summary: string; description: string | null; start: string; end: string; htmlLink: string | null;
  attendees: { email: string; name: string | null; response: string | null }[]; location: string | null; meetUrl: string | null; status: string;
}

/** Same fields as the CRM's normaliseEvent. Unlike the CRM, untitled events are kept: they are still busy time. */
function toEvent(e: any): CalEvent {
  return {
    id: e.id, summary: e.summary ?? "", description: e.description ?? null,
    start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? e.end?.date ?? "", htmlLink: e.htmlLink ?? null,
    attendees: (e.attendees ?? []).filter((a: any) => a.email).map((a: any) => ({ email: a.email, name: a.displayName ?? null, response: a.responseStatus ?? null })),
    location: e.location ?? null,
    meetUrl: e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p: any) => p.entryPointType === "video")?.uri ?? null, status: e.status ?? "",
  };
}

export async function listEvents(mailbox: string, calendarId: string, timeMin: string, timeMax: string): Promise<CalEvent[]> {
  const h = await authHeaders(mailbox, SCOPES.calendarRead);
  return collect<CalEvent, string>("", async (pageToken) => {
    const r = await call<any>(spec, {
      url: `${API}/calendars/${encodeURIComponent(calendarId)}/events`, headers: h,
      query: { timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 250, pageToken: pageToken || undefined },
    });
    return { items: (r.data?.items ?? []).map(toEvent), next: r.data?.nextPageToken ?? null };
  }, { maxPages: 40 });
}

export async function freeBusy(mailbox: string, calendars: string[], timeMin: string, timeMax: string): Promise<Record<string, { start: string; end: string }[]>> {
  const h = await authHeaders(mailbox, SCOPES.calendarRead);
  const r = await call<any>(spec, { method: "POST", url: `${API}/freeBusy`, headers: h, json: { timeMin, timeMax, items: calendars.map((id) => ({ id })) } });
  const out: Record<string, { start: string; end: string }[]> = {};
  for (const [id, v] of Object.entries<any>(r.data?.calendars ?? {})) out[id] = v.busy ?? [];
  return out;
}

/**
 * Creates an event. Needs KIT_ALLOW_WRITES=1. Invitations go out only with notify: true.
 * With a meetingUrl (Zoom, Teams), that link goes in the location and description, conferencing is
 * switched off, and if Workspace attaches a Google Meet link anyway it is stripped straight after, so
 * the guest sees one link. A failed strip is reported, not thrown: the booking itself stands.
 */
export async function createEvent(mailbox: string, e: { summary: string; start: string; end: string; timeZone?: string; attendees?: (string | { email: string; name?: string })[]; description?: string; location?: string; meetingUrl?: string; notify?: boolean }): Promise<CalEvent & { meetStripFailed?: boolean }> {
  const h = await authHeaders(mailbox, SCOPES.calendarWrite);
  const tz = e.timeZone ?? "Australia/Sydney";
  const description = e.meetingUrl ? [`Join: ${e.meetingUrl}`, "", e.description ?? ""].join("\n").trim() : e.description;
  const r = await call<any>(spec, {
    method: "POST", url: `${API}/calendars/primary/events`, headers: h,
    query: { sendUpdates: e.notify ? "all" : "none", ...(e.meetingUrl ? { conferenceDataVersion: 1 } : {}) },
    json: {
      summary: e.summary, description, location: e.meetingUrl ?? e.location,
      start: { dateTime: e.start, timeZone: tz }, end: { dateTime: e.end, timeZone: tz },
      // One entry per address, keeping a display name when given, as the CRM sends the client's name.
      attendees: Array.from(new Map((e.attendees ?? []).map((a) => typeof a === "string" ? { email: a } : a).map((a) => [a.email.toLowerCase(), { email: a.email, ...(a.name ? { displayName: a.name } : {}) }])).values()),
      ...(e.meetingUrl ? { conferenceData: null } : {}), reminders: { useDefault: true },
    },
  });
  const ev = toEvent(r.data);
  if (!ev.id) throw new Error("calendar: Google returned no event id, so the booking cannot be confirmed");
  if (e.meetingUrl && (r.data?.hangoutLink || r.data?.conferenceData)) {
    try {
      await call(spec, { method: "PATCH", url: `${API}/calendars/primary/events/${encodeURIComponent(ev.id)}`, headers: h, query: { conferenceDataVersion: 1, sendUpdates: "none" }, json: { conferenceData: null } });
      return { ...ev, meetUrl: null };
    } catch { return { ...ev, meetStripFailed: true }; }
  }
  return ev;
}

/** Cancels an event and tells the guests. Needs KIT_ALLOW_WRITES=1. An event already gone counts as cancelled. */
export async function cancelEvent(mailbox: string, eventId: string, notify = true): Promise<void> {
  const h = await authHeaders(mailbox, SCOPES.calendarWrite);
  try {
    await call(spec, { method: "DELETE", url: `${API}/calendars/primary/events/${encodeURIComponent(eventId)}`, headers: h, query: { sendUpdates: notify ? "all" : "none" } });
  } catch (err: any) {
    if (err?.status !== 404 && err?.status !== 410) throw err;
  }
}
