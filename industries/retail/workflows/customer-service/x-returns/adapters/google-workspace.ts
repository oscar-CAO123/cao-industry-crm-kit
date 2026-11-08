// Gmail: return requests from the business's own inbox, the reply as a Gmail draft in the same thread, and a queued send.
// The mailbox is the one set in the secret store (GOOGLE_MAILBOX), so the calls use userId "me".
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Request, type Settings, EMAIL, keyOf } from "../types.ts";

const P = "google-workspace";
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const DEFAULT_SEARCH = "subject:(return OR returns OR exchange OR refund) newer_than:14d";
const header = (v: string) => v.replace(/[\r\n]+/g, " ").slice(0, 200);
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export const googleWorkspace: Adapter = {
  id: P,
  async requests(ctx) {
    const s = ctx.settings;
    const list = await ctx.draft<any>({ platform: P, op: "gmail.users.messages.list", summary: "read return requests", input: { params: {
      userId: "me", q: header(s.search ?? DEFAULT_SEARCH), maxResults: 25 } } });
    const out: Omit<Request, "status">[] = [];
    for (const m of list.data?.messages ?? []) {
      if (!ID.test(String(m.id ?? ""))) continue;
      const g = await ctx.draft<any>({ platform: P, op: "gmail.users.messages.get", summary: "read request headers", input: { params: {
        userId: "me", id: m.id, format: "metadata" } } });
      const h = (name: string) => String(g.data?.payload?.headers?.find((x: any) => String(x.name).toLowerCase() === name.toLowerCase())?.value ?? "");
      const from = h("From").match(/<([^>]+)>/)?.[1] ?? h("From").trim();
      out.push({
        id: keyOf(`gmail:${m.id}`), source: P, subject: header(h("Subject")), received: new Date(Number(g.data?.internalDate ?? ctx.now.getTime())).toISOString(),
        ref: { message_id: m.id, thread_id: ID.test(String(g.data?.threadId ?? "")) ? String(g.data.threadId) : "", from: EMAIL.test(from) ? from : "" },
      });
    }
    return out;
  },
  async queueReply(ctx, r, text) {
    const to = r.ref.from;
    if (!to || !EMAIL.test(to)) throw new Error("google-workspace: request has no valid sender address");
    const subject = /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`;
    const threadId = r.ref.thread_id ? { threadId: r.ref.thread_id } : {};
    const raw = b64url(`To: ${to}\r\nSubject: ${header(subject)}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}`);
    const d = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft return reply to ${to}`, input: { params: { userId: "me" }, body: { message: { raw, ...threadId } } } });
    const draftId = String(d.data?.id ?? "");
    if (!ID.test(draftId)) throw new Error("google-workspace: draft not created");
    return ctx.queue({ platform: P, op: "gmail.users.drafts.send", key: `send:${r.id}`, summary: `send return reply to ${to}`,
      input: { params: { userId: "me" }, body: { id: draftId } } }, `Send return reply to ${to}: ${r.subject}`);
  },
};
