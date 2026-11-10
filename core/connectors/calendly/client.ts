// Calendly helper: who has booked, and when. Read only.
// Key: CALENDLY_API_TOKEN (a personal access token).
//
// Source, from the reference CRM at commit 28aa5d91:
//   me, listScheduledEvents, listInvitees, bookings
//     scripts/crm-pipeline-advancer.ts and scripts/crm-cold-lead-promoter.ts
//     (users/me for the organisation, active events only, pagination.next_page, invitees 8 at a time)
//   cancelledBookings  scripts/crm-pipeline-advancer.ts fetchCancelledBookings (status=canceled, who cancelled, reason)
// Changed on purpose: the CRM stops at 6 pages and logs; the kit throws, so a short list is never mistaken for a full one.

import { call, checkUrl, type AppSpec } from "../../lib/http.ts";
import { secret } from "../../lib/secrets.ts";
import { collect } from "../../lib/paging.ts";

export const spec: AppSpec = { app: "calendly", hosts: ["api.calendly.com"] };
const auth = () => ({ Authorization: `Bearer ${secret("CALENDLY_API_TOKEN")}` });

export async function me(): Promise<{ uri: string; email: string; organization: string }> {
  const r = await call<any>(spec, { url: "https://api.calendly.com/users/me", headers: auth() });
  const x = r.data?.resource;
  if (!x?.current_organization) throw new Error("Calendly returned no organisation for this token");
  return { uri: x.uri, email: x.email, organization: x.current_organization };
}

export async function listScheduledEvents(o: { organization: string; minStart: string; maxStart?: string; status?: "active" | "canceled" }): Promise<any[]> {
  const first = new URL("https://api.calendly.com/scheduled_events");
  first.searchParams.set("organization", o.organization);
  first.searchParams.set("count", "100");
  first.searchParams.set("min_start_time", o.minStart);
  if (o.maxStart) first.searchParams.set("max_start_time", o.maxStart);
  first.searchParams.set("status", o.status ?? "active");
  const h = auth();
  return collect<any, string>(first.toString(), async (url) => {
    const r = await call<any>(spec, { url, headers: h });
    const next = r.data?.pagination?.next_page ?? null;
    if (next) checkUrl(spec, new URL(next));
    return { items: r.data?.collection ?? [], next };
  }, { maxPages: 50 });
}

export async function listInvitees(eventUri: string): Promise<any[]> {
  const u = new URL(`${eventUri}/invitees`);
  checkUrl(spec, u);
  const r = await call<any>(spec, { url: u.toString(), headers: auth() });
  return (r.data?.collection ?? []).filter((x: any) => x.email && x.status === "active");
}

export interface Booking { email: string; name: string; host: string; event: string; start: string; created: string; timezone: string | null }

/** Every active booking since a time, with each invitee. Invitees are read 8 events at a time. */
export async function bookings(minStart: string): Promise<Booking[]> {
  const { organization } = await me();
  const events = await listScheduledEvents({ organization, minStart });
  const out: Booking[] = [];
  for (let i = 0; i < events.length; i += 8) {
    const batch = await Promise.all(events.slice(i, i + 8).map(async (e) => {
      const host = (e.event_memberships ?? []).map((m: any) => String(m.user_email ?? "")).join(",");
      return (await listInvitees(e.uri)).map((x: any) => ({ email: String(x.email).trim().toLowerCase(), name: x.name ?? "", host, event: e.name, start: e.start_time, created: e.created_at, timezone: typeof x.timezone === "string" ? x.timezone : null }));
    }));
    out.push(...batch.flat());
  }
  return out;
}

/**
 * Cancelled bookings since a time, with who cancelled ("client" when the invitee did) and why.
 * Ported from the CRM's fetchCancelledBookings.
 */
export async function cancelledBookings(minStart: string): Promise<{ email: string; event: string; start: string; by: "client" | "host"; reason: string }[]> {
  const { organization } = await me();
  const events = await listScheduledEvents({ organization, minStart, status: "canceled" });
  const out: { email: string; event: string; start: string; by: "client" | "host"; reason: string }[] = [];
  for (const e of events) {
    const u = new URL(`${e.uri}/invitees`); checkUrl(spec, u);
    const r = await call<any>(spec, { url: u.toString(), headers: auth() });
    for (const x of r.data?.collection ?? []) {
      if (!x.email) continue;
      out.push({ email: String(x.email).trim().toLowerCase(), event: e.name, start: e.start_time, by: e.cancellation?.canceler_type === "invitee" ? "client" : "host", reason: String(e.cancellation?.reason ?? "") });
    }
  }
  return out;
}
