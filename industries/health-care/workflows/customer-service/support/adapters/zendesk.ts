// Zendesk: the help desk where enquiries arrive. This adapter reads tickets and requesters, and builds the one live
// operation: a public reply on a ticket. The cron only queues that reply; a person approves it first.
// Field names from Zendesk's official spec (TicketObject, TicketResponse, TicketsResponse, UserObject, TicketUpdateRequest).
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Contact, cap, EMAIL } from "../types.ts";

const P = "zendesk";
const id = (v: unknown) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw new Error("zendesk: bad id"); return n; };

export interface TicketRead { id: number; status: string; subject?: string; description?: string; requester_id?: number; created_at?: string }

/** The newest tickets that are still new. Anything without a whole-number id is dropped. */
export async function newTickets(ctx: Ctx<Settings>): Promise<TicketRead[]> {
  const r = await ctx.draft<{ tickets?: TicketRead[] }>({ platform: P, op: "core.ListTickets", summary: "read newest tickets",
    input: { params: { sort_by: "created_at", sort_order: "desc", per_page: 50 } } });
  return (r.data?.tickets ?? []).filter((t) => t.status === "new" && Number.isSafeInteger(t.id));
}

/** One ticket, fresh: its status decides whether a chaser is due. */
export async function ticket(ctx: Ctx<Settings>, ticketId: number): Promise<TicketRead | undefined> {
  const r = await ctx.draft<{ ticket?: TicketRead }>({ platform: P, op: "core.ShowTicket", summary: `read ticket ${ticketId}`,
    input: { params: { ticket_id: id(ticketId) } } });
  return r.data?.ticket;
}

/** The person who wrote in: name and email, when the help desk holds a valid email. */
export async function requester(ctx: Ctx<Settings>, userId: number): Promise<Contact> {
  const r = await ctx.draft<{ user?: { name?: string; email?: string } }>({ platform: P, op: "core.ShowUser", summary: "read requester",
    input: { params: { user_id: id(userId) } } });
  const u = r.data?.user ?? {};
  return { name: cap(u.name, 120) || undefined, email: EMAIL.test(u.email ?? "") ? u.email : undefined };
}

/** A public reply on a ticket. This is live: it only ever runs as an approved act. */
export function replyAct(ticketId: number, body: string, key: string, summary: string): Act {
  return { platform: P, op: "core.UpdateTicket", key, summary,
    input: { params: { ticket_id: id(ticketId) }, body: { ticket: { comment: { body: cap(body, 4000), public: true } } } } };
}
