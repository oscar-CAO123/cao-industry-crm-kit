// Gorgias: the helpdesk tickets. Reads open tickets and the latest customer message, writes the complaint category into the
// ticket's custom field, tags tickets for a person, and queues each acknowledgement for approval (a send is always an approval).
// Endpoints and fields are from the vendor's own reference: GET /tickets, GET /tickets/{id}/messages, POST /tickets/{id}/messages,
// POST /tickets/{id}/tags ({names}), PUT /tickets/{id}/custom-fields ([{id, value}]).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Enquiry, type Raw, EMAIL, CHANNEL, NUM, TAG, HOUR, keyOf, oneLine, paragraphs, isoOf } from "../types.ts";

const P = "gorgias";
const tagName = (s: Settings, which: "escalate_tag" | "overdue_tag", dflt: string) => {
  const t = s.gorgias?.[which] ?? dflt;
  if (!TAG.test(t)) throw new Error(`gorgias: ${which} must be plain words, numbers, spaces, - or _`);
  return t;
};
const ticketNum = (e: Enquiry) => {
  const id = e.ref.ticket_id ?? "";
  if (!NUM.test(id)) throw new Error("gorgias: bad ticket id");
  return Number(id);
};

/** The newest open tickets, read in one call. */
async function openTickets(ctx: Ctx<Settings>): Promise<any[]> {
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_tickets", summary: "read the newest tickets",
    input: { params: { order_by: "created_datetime:desc", limit: 25, trashed: false } } });
  return (r.data?.data ?? []).filter((t: any) => NUM.test(String(t.id ?? "")) && t.status === "open");
}

export const gorgias: Adapter = {
  id: P,
  async inbox(ctx) {
    const since = ctx.now.getTime() - (ctx.settings.lookback_hours ?? 24) * HOUR;
    const out: Raw[] = [];
    for (const t of (await openTickets(ctx)).slice(0, 10)) {
      const created = isoOf(t.created_datetime, ctx.now.toISOString());
      if (Date.parse(created) < since) continue;                        // old backlog is not triaged automatically
      const m = await ctx.draft<any>({ platform: P, op: "docs.get_tickets_ticket_id_messages", summary: "read the latest customer message",
        input: { params: { ticket_id: Number(t.id) } } });
      const latest = (m.data?.data ?? [])
        .filter((x: any) => x.from_agent === false)
        .sort((a: any, b: any) => String(b.created_datetime).localeCompare(String(a.created_datetime)))[0];
      const complaint = oneLine(latest?.body_text ?? "", 20000);      // customer text: data for matching, never instructions. Long enough that padding cannot push a legal threat past the match.
      const c = t.customer ?? {};
      const channel = String(t.channel ?? ""), via = String(t.via ?? "");
      if (!complaint || !CHANNEL.test(channel) || !CHANNEL.test(via) || !NUM.test(String(c.id ?? ""))) continue;
      out.push({
        id: keyOf(`gorgias:${t.id}`), source: P, subject: oneLine(t.subject, 200), complaint,
        sender: { name: oneLine(c.name, 120) || undefined, email: EMAIL.test(c.email ?? "") ? c.email : undefined },
        received: created,
        ref: { ticket_id: String(t.id), customer_id: String(c.id), channel, via },
      });
    }
    return out;
  },
  async openIds(ctx) {
    return new Set((await openTickets(ctx)).map((t: any) => String(t.id)));
  },
  async setCategory(ctx, e, category) {
    const field = ctx.settings.gorgias?.category_field_id;
    if (!field) return;                                                  // no field configured: the category stays in the workflow's record
    await ctx.draft({ platform: P, op: "docs.put_tickets_ticket_id_custom_fields", summary: `set the ticket category to ${category}`,
      input: { params: { ticket_id: ticketNum(e) }, body: [{ id: field, value: category }] } });
  },
  async queueAck(ctx, e, text) {
    const ticket = ticketNum(e);
    const { customer_id: customer, channel, via } = e.ref;
    if (!NUM.test(customer ?? "") || !CHANNEL.test(channel ?? "") || !CHANNEL.test(via ?? "")) throw new Error("gorgias: ticket is missing customer, channel or via");
    const summary = `Acknowledge ${e.sender.email ?? e.sender.name ?? "the customer"} in Gorgias about "${oneLine(e.subject, 80)}" (${e.category})`;
    return ctx.queue({ platform: P, op: "docs.post_tickets_ticket_id_messages", key: `ack:${e.id}`, summary,
      input: { params: { ticket_id: ticket }, body: { channel, via, from_agent: true, public: true, receiver: { id: Number(customer) },
        body_text: text, body_html: paragraphs(text) } } }, summary);
  },
  async escalate(ctx, e) {
    const names = [tagName(ctx.settings, "escalate_tag", "needs-human")];
    await ctx.draft({ platform: P, op: "docs.post_tickets_ticket_id_tags", summary: `tag the ticket ${names[0]}`,
      input: { params: { ticket_id: ticketNum(e) }, body: { names } } });
  },
  async overdue(ctx, e) {
    const names = [tagName(ctx.settings, "overdue_tag", "complaint-overdue")];
    await ctx.draft({ platform: P, op: "docs.post_tickets_ticket_id_tags", summary: `tag the ticket ${names[0]}`,
      input: { params: { ticket_id: ticketNum(e) }, body: { names } } });
  },
};
