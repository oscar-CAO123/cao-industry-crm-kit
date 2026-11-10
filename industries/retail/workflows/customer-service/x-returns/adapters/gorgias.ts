// Gorgias: return tickets from the helpdesk, and the reply posted on the ticket. A ticket reply reaches the customer,
// so it is only ever queued for approval.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Request, type Settings, keyOf } from "../types.ts";

const P = "gorgias";
const RETURN = /return|exchange|refund/i;

export const gorgias: Adapter = {
  id: P,
  async requests(ctx: Ctx<Settings>) {
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_tickets", summary: "read recent tickets", input: { params: {
      order_by: "created_datetime:desc", limit: 50 } } });
    return (r.data?.data ?? [])
      .filter((t: any) => RETURN.test(String(t.subject ?? "")))
      .map((t: any) => ({
        id: keyOf(`gorgias:${t.id}`), source: P, subject: String(t.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, 200),
        received: String(t.created_datetime ?? ctx.now.toISOString()), ref: { ticket_id: String(t.id) },
      }));
  },
  async queueReply(ctx, r, text) {
    const ticket = r.ref.ticket_id;
    if (!/^\d{1,18}$/.test(ticket ?? "")) throw new Error("gorgias: bad ticket id");
    return ctx.queue({ platform: P, op: "docs.post_tickets_ticket_id_messages", key: `send:${r.id}`, summary: `reply on ticket ${ticket}`,
      input: { params: { ticket_id: ticket }, body: { channel: "email", from_agent: true, public: true, body_text: text } } },
      `Reply on Gorgias ticket ${ticket}: ${r.subject}`);
  },
};
