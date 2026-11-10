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

/** Most pages one event's attendee list is followed through. Beyond it the list is refused, never read in part. */
export const MAX_ATTENDEE_PAGES = 20;

/**
 * Every page of attendees, followed by the continuation token (spec: Paginated Responses). `more` is true only when the
 * list was refused: the page cap was hit, or Eventbrite said there are more pages but gave no token. A refused list
 * returns no items, so a caller never counts or registers part of an event.
 */
export async function attendees(ctx: Ctx<Settings>, eventId: string, changedSince?: string): Promise<{ items: Attendee[]; more: boolean }> {
  const base: Record<string, unknown> = { event_id: eid(eventId) };
  if (changedSince) {
    const d = new Date(changedSince);
    if (Number.isNaN(d.getTime())) throw new Error("eventbrite: bad changed_since");
    base.changed_since = d.toISOString();
  }
  const items: Attendee[] = [];
  let continuation: string | undefined;
  for (let page = 1; page <= MAX_ATTENDEE_PAGES; page++) {
    const params = continuation ? { ...base, continuation } : base;
    const r = await ctx.draft<{ attendees?: Attendee[]; pagination?: { has_more_items?: boolean; continuation?: string } }>({ platform: P,
      op: "get:/events/{event_id}/attendees/", summary: `read attendees for event ${eventId}, page ${page}`, input: { params } });
    items.push(...(r.data?.attendees ?? []));
    const pg = r.data?.pagination;
    if (pg?.has_more_items !== true) return { items, more: false };
    if (!pg.continuation) break;
    continuation = pg.continuation;
  }
  ctx.log(`attendees ${eventId}: more than ${MAX_ATTENDEE_PAGES} pages or no continuation token; list refused, nothing read`);
  return { items: [], more: true };
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
