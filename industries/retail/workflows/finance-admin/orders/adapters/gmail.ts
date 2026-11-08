// Gmail: where order emails arrive, and where the confirmation is drafted. Reads and drafts go through ctx.draft, so the
// runtime's draft list is the gate. The only send is gmail.users.drafts.send, which the cron queues and a person approves.
// Field names come from the Gmail spec (endpoint-map raw/google-workspace/spec/gmail_v1.json): Message.threadId,
// MessagePart.headers, MessagePartHeader.name/value, Draft.id, Draft.message.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { rawMessage } from "../../../../../../core/connectors/google-workspace/gmail.ts";
import { type Settings, type Order, GMAIL_ID, clean, sender } from "../types.ts";

const P = "google-workspace" as const;
const ME = "me";

export const gmail = {
  /** New order emails matching the search. Reads only. */
  async enquiries(ctx: Ctx<Settings>): Promise<Omit<Order, "status">[]> {
    const list = await ctx.draft<any>({ platform: P, op: "gmail.users.messages.list", summary: "list new order emails",
      input: { params: { userId: ME, q: clean(ctx.settings.order_search, 200), maxResults: 25 } } });
    const out: Omit<Order, "status">[] = [];
    for (const m of (list.data?.messages ?? []).slice(0, 25)) {
      const id = clean(m?.id, 64);
      if (!GMAIL_ID.test(id)) continue;
      const r = await ctx.draft<any>({ platform: P, op: "gmail.users.messages.get", summary: "read order email headers",
        input: { params: { userId: ME, id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] } } });
      const header = (n: string) => (r.data?.payload?.headers ?? []).find((h: any) => String(h.name).toLowerCase() === n.toLowerCase())?.value;
      const from = sender(header("From"));
      if (!from.email) continue;
      const thread = clean(r.data?.threadId, 64);
      out.push({ id: `gmail-${id}`, title: clean(header("Subject"), 200), contact: { name: from.name, email: from.email },
        thread: GMAIL_ID.test(thread) ? thread : undefined,
        received: new Date(Number(r.data?.internalDate ?? Date.now())).toISOString() });
    }
    return out;
  },
  /** A confirmation draft in the mailbox (a draft operation). Returns the draft id. Never sends. */
  async confirmation(ctx: Ctx<Settings>, o: Order, text: string): Promise<string> {
    const to = o.contact.email ?? "";
    const raw = rawMessage({ from: ctx.settings.mailbox, to, subject: `Your order${o.title ? `: ${clean(o.title, 120)}` : ""}`, text,
      fromName: clean(ctx.settings.business_name, 120) || undefined, toName: o.contact.name || undefined });
    const body = { message: { raw, ...(o.thread ? { threadId: o.thread } : {}) } };
    const r = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft order confirmation to ${to}`,
      input: { params: { userId: ME }, body } });
    const id = clean(r.data?.id, 64);
    if (!GMAIL_ID.test(id)) throw new Error("google-workspace: draft not created");
    return id;
  },
  /** The approval act that sends the drafted confirmation. A live operation: the cron only queues it. */
  sendAct(o: Order, draftId: string, summary: string): Act {
    return { platform: P, op: "gmail.users.drafts.send", summary, key: `send:${o.id}`, input: { params: { userId: ME }, body: { id: draftId } } };
  },
};
