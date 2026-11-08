// Zendesk: the ticket a policy question arrives on, the help centre that holds the wording, and the reply.
// Field names are confirmed against the vendor spec (ticket.comment.body / ticket.comment.public, tickets[], articles[]).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, ticketId } from "../types.ts";

const P = "zendesk";
const OPEN = new Set(["new", "open", "pending", "hold"]);

export const zendesk: Adapter = {
  id: P,
  async enquiries(ctx: Ctx<Settings>) {
    const r = await ctx.draft<any>({ platform: P, op: "core.ListTickets", summary: "read recent tickets",
      input: { params: { per_page: 100, sort_by: "created_at", sort_order: "desc" } } });
    const group = ctx.settings.zendesk.group_id;
    return (r.data?.tickets ?? [])
      .filter((t: any) => OPEN.has(t.status) && (group == null || Number(t.group_id) === Number(group)))
      .map((t: any) => ({
        id: String(ticketId(t.id)), source: P as "zendesk", title: String(t.subject ?? "").slice(0, 300),
        text: String(t.description ?? "").slice(0, 4000), received: String(t.created_at ?? ""),
        contact: {}, ref: { ticket_id: String(ticketId(t.id)), requester_id: String(t.requester_id ?? "") },
      }));
  },
  async articles(ctx: Ctx<Settings>) {
    const r = await ctx.draft<any>({ platform: P, op: "help_center.ListArticles", summary: "read help centre articles",
      input: { params: { locale: ctx.settings.zendesk.locale, per_page: 100 } } });
    return (r.data?.articles ?? []).filter((a: any) => !a.draft).map((a: any) => ({
      id: String(ticketId(a.id)), title: String(a.title ?? ""), body: String(a.body ?? ""), html_url: String(a.html_url ?? ""),
    }));
  },
  async status(ctx: Ctx<Settings>, ticket: string) {
    const r = await ctx.draft<any>({ platform: P, op: "core.ShowTicket", summary: `ticket ${ticket} status`,
      input: { params: { ticket_id: ticketId(ticket) } } });
    return r.data?.ticket?.status;
  },
};
