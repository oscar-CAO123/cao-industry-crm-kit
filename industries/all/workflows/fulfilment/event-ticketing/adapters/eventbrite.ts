// Eventbrite: the one platform this workflow maps. Reads events, ticket types, attendees and teams for drafts, and queues
// publishing for approval. Every operation id here is in core/sdk/platforms/eventbrite/ops.json. Parameter and field
// names come from the vendor spec (endpoint-map/raw/eventbrite/spec.apib).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Attendee, EventRow, Settings, Team, TicketClass } from "../types.ts";

export const P = "eventbrite";
const ID = /^[0-9]{1,20}$/;
export const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
export const eid = (v: unknown): string => {
  if (!isId(v)) throw new Error("eventbrite: bad id");
  return v;
};
export const eventIds = (ctx: Ctx<Settings>): string[] => (ctx.settings.event_ids ?? []).map(eid);

export async function readEvent(ctx: Ctx<Settings>, eventId: string): Promise<EventRow> {
  const r = await ctx.draft<EventRow>({ platform: P, op: "get:/events/{event_id}/", summary: `read event ${eventId}`,
    input: { params: { event_id: eid(eventId) } } });
  return r.data ?? {};
}

export async function ticketClasses(ctx: Ctx<Settings>, eventId: string): Promise<TicketClass[]> {
  const r = await ctx.draft<{ ticket_classes?: TicketClass[] }>({ platform: P, op: "get:/events/{event_id}/ticket_classes/",
    summary: `read ticket types for event ${eventId}`, input: { params: { event_id: eid(eventId) } } });
  return r.data?.ticket_classes ?? [];
}

/** One page of attendees. `more` is true when Eventbrite has further pages, which the kit's operation map cannot request. */
export async function attendees(ctx: Ctx<Settings>, eventId: string, changedSince?: string): Promise<{ items: Attendee[]; more: boolean }> {
  const params: Record<string, unknown> = { event_id: eid(eventId) };
  if (changedSince) {
    const d = new Date(changedSince);
    if (Number.isNaN(d.getTime())) throw new Error("eventbrite: bad changed_since");
    params.changed_since = d.toISOString();
  }
  const r = await ctx.draft<{ attendees?: Attendee[]; pagination?: { has_more_items?: boolean } }>({ platform: P,
    op: "get:/events/{event_id}/attendees/", summary: `read attendees for event ${eventId}`, input: { params } });
  return { items: r.data?.attendees ?? [], more: r.data?.pagination?.has_more_items === true };
}

export async function teams(ctx: Ctx<Settings>, eventId: string): Promise<Team[]> {
  const r = await ctx.draft<{ teams?: Team[] }>({ platform: P, op: "get:/events/{event_id}/teams/",
    summary: `read check-in teams for event ${eventId}`, input: { params: { event_id: eid(eventId) } } });
  return r.data?.teams ?? [];
}

/** Queue the publish of one event. Publishing is customer-visible, so it only ever waits for a person. */
export function queuePublish(ctx: Ctx<Settings>, eventId: string, summary: string): Promise<string> {
  const id = eid(eventId);
  return ctx.queue({ platform: P, op: "post:/events/{event_id}/publish/", key: `publish-${id}`, summary,
    input: { params: { event_id: id } } }, summary);
}
