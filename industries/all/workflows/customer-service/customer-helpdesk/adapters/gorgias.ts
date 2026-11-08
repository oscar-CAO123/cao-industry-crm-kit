// Gorgias: the helpdesk tickets. Reads open tickets and the latest customer message, takes the answer from a macro's
// response text, queues the reply for approval (a send is always an approval) and tags tickets that need a person.
// Gorgias has no reminder operation in the mapped ops, so waiting questions get no chase here.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Enquiry, type Rule, EMAIL, CHANNEL, NUM, TAG, ANSWER_MAX, keyOf, oneLine, paragraphs, isoOf } from "../types.ts";

const P = "gorgias";
const tagName = (ctx: Ctx<Settings>) => {
  const t = ctx.settings.gorgias?.escalate_tag ?? "needs-human";
  if (!TAG.test(t)) throw new Error("gorgias: escalate_tag must be plain words, numbers, spaces, - or _");
  return t;
};
const ticketNum = (e: Enquiry) => {
  const id = e.ref.ticket_id ?? "";
  if (!NUM.test(id)) throw new Error("gorgias: bad ticket id");
  return Number(id);
};

export const gorgias: Adapter = {
  id: P,
  async inbox(ctx) {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_tickets", summary: "read the newest tickets",
      input: { params: { order_by: "created_datetime:desc", limit: 25, trashed: false } } });
    const open = (r.data?.data ?? []).filter((t: any) => NUM.test(String(t.id ?? "")) && t.status === "open").slice(0, 10);
    const out = [];
    for (const t of open) {
      const m = await ctx.draft<any>({ platform: P, op: "docs.get_messages", summary: "read the latest customer message",
        input: { params: { ticket_id: Number(t.id), order_by: "created_datetime:desc", limit: 5 } } });
      const inbound = (m.data?.data ?? []).find((x: any) => x.from_agent === false);
      const question = oneLine(inbound?.body_text ?? "", 2000);
      const c = t.customer ?? {};
      const channel = String(t.channel ?? ""), via = String(t.via ?? "");
      if (!question || !CHANNEL.test(channel) || !CHANNEL.test(via) || !NUM.test(String(c.id ?? ""))) continue;
      out.push({
        id: keyOf(`gorgias:${t.id}`), source: P, subject: oneLine(t.subject, 200), question,
        sender: { name: oneLine(c.name, 120) || undefined, email: EMAIL.test(c.email ?? "") ? c.email : undefined },
        received: isoOf(t.created_datetime, ctx.now.toISOString()),
        ref: { ticket_id: String(t.id), customer_id: String(c.id), channel, via },
      });
    }
    return out;
  },
  async knowledge(ctx, rule: Rule) {
    const id = rule.gorgias?.macro_id;
    if (!Number.isInteger(id) || (id as number) <= 0) return undefined;
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_macros_id", summary: `read macro for ${rule.name}`,
      input: { params: { id } } });
    if (r.data?.archived_datetime) return undefined;   // an archived macro is never sent
    const action = (r.data?.actions ?? []).find((a: any) => a?.name === "setResponseText" && typeof a?.arguments?.body_text === "string");
    const text = String(action?.arguments?.body_text ?? "").trim().slice(0, ANSWER_MAX);
    // Macro variables such as {{ticket.customer.firstname}} are filled in the app, not by the API: a raw one is never sent.
    if (text.length < 20 || /\{\{|\{%/.test(text)) return undefined;
    return { text };
  },
  async queueReply(ctx, e, answer) {
    const ticket = ticketNum(e);
    const { customer_id: customer, channel, via } = e.ref;
    if (!NUM.test(customer ?? "") || !CHANNEL.test(channel ?? "") || !CHANNEL.test(via ?? "")) throw new Error("gorgias: ticket is missing customer, channel or via");
    const summary = `Reply in Gorgias to ${e.sender.email ?? e.sender.name ?? "the customer"} about "${oneLine(e.subject, 80)}" (rule: ${e.rule})`;
    return ctx.queue({ platform: P, op: "docs.post_tickets_ticket_id_messages", key: `reply:${e.id}`, summary,
      input: { params: { ticket_id: ticket }, body: { channel, via, from_agent: true, public: true, receiver: { id: Number(customer) },
        body_text: answer.text, body_html: paragraphs(answer.text) } } }, summary);
  },
  async escalate(ctx, e) {
    const tag = tagName(ctx);
    await ctx.draft({ platform: P, op: "docs.post_tickets_ticket_id_tags", summary: `tag the ticket ${tag}`,
      input: { params: { ticket_id: ticketNum(e) }, body: { names: [tag] } } });
  },
};
