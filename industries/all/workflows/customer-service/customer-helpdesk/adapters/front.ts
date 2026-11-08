// Front: the shared inbox. Reads open, unassigned conversations and the latest customer message, takes the answer from a
// published knowledge base article, queues the reply for approval (a send is always an approval), hands escalations to
// the teammate and sets a reminder on waiting questions.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Enquiry, type Rule, ID, EMAIL, ANSWER_MAX, keyOf, oneLine, paragraphs, stripHtml } from "../types.ts";

const P = "front";
const cfg = (ctx: Ctx<Settings>) => {
  const f = ctx.settings.front;
  if (!f || !ID.test(f.inbox_id ?? "") || !ID.test(f.channel_id ?? "") || !ID.test(f.teammate_id ?? "")) {
    throw new Error("front: inbox_id, channel_id and teammate_id must be set in settings");
  }
  return f;
};
const convId = (e: Enquiry) => {
  const id = e.ref.conversation_id ?? "";
  if (!ID.test(id)) throw new Error("front: bad conversation id");
  return id;
};

export const front: Adapter = {
  id: P,
  async inbox(ctx) {
    const f = cfg(ctx);
    const r = await ctx.draft<any>({ platform: P, op: "core-api_core-api.list-inbox-conversations", summary: "read shared inbox",
      input: { params: { inbox_id: f.inbox_id, limit: 25 } } });
    const open = (r.data?._results ?? []).filter((c: any) => ID.test(String(c.id ?? "")) && !c.is_closed && !c.assignee).slice(0, 10);
    const out = [];
    for (const c of open) {
      const m = await ctx.draft<any>({ platform: P, op: "core-api_core-api.list-conversation-messages", summary: "read latest customer message",
        input: { params: { conversation_id: String(c.id), limit: 10, sort_order: "desc" } } });
      const inbound = (m.data?._results ?? []).filter((x: any) => x.is_inbound === true)
        .sort((a: any, b: any) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0];
      const question = oneLine(inbound?.text ?? inbound?.blurb ?? "", 2000);
      if (!question) continue;
      out.push({
        id: keyOf(`front:${c.id}`), source: P, subject: oneLine(c.subject, 200), question,
        sender: { name: oneLine(c.recipient?.name, 120) || undefined, email: EMAIL.test(c.recipient?.handle ?? "") ? c.recipient.handle : undefined },
        received: typeof c.created_at === "number" ? new Date(c.created_at * 1000).toISOString() : ctx.now.toISOString(),
        ref: { conversation_id: String(c.id) },
      });
    }
    return out;
  },
  async knowledge(ctx, rule: Rule) {
    const id = rule.front?.article_id;
    if (!id || !ID.test(id)) return undefined;
    const r = await ctx.draft<any>({ platform: P, op: "core-api_core-api.get-a-knowledge-base-article", summary: `read knowledge article for ${rule.name}`,
      input: { params: { article_id: id } } });
    if (r.data?.status !== "published") return undefined;   // a draft or archived article is never sent to a customer
    const text = stripHtml(String(r.data?.content ?? "")).slice(0, ANSWER_MAX);
    return text.length >= 20 ? { text } : undefined;
  },
  async queueReply(ctx, e, answer) {
    const f = cfg(ctx), id = convId(e);
    const summary = `Reply in Front to ${e.sender.email ?? e.sender.name ?? "the sender"} about "${oneLine(e.subject, 80)}" (rule: ${e.rule})`;
    return ctx.queue({ platform: P, op: "core-api_core-api.create-message-reply", key: `reply:${e.id}`, summary,
      input: { params: { conversation_id: id }, body: { body: paragraphs(answer.text), channel_id: f.channel_id } } }, summary);
  },
  async escalate(ctx, e) {
    const f = cfg(ctx), id = convId(e);
    await ctx.draft({ platform: P, op: "core-api_core-api.update-conversation-assignee", summary: "assign the conversation to the teammate",
      input: { params: { conversation_id: id }, body: { assignee_id: f.teammate_id } } });
  },
  async chase(ctx, e) {
    const f = cfg(ctx), id = convId(e);
    // Front only takes a reminder time in the future, so it is set five minutes out.
    const due = ctx.now.getTime() + 5 * 60e3;
    await ctx.draft({ platform: P, op: "core-api_core-api.update-conversation-reminders", summary: "remind the teammate to answer",
      input: { params: { conversation_id: id }, body: { teammate_id: f.teammate_id, scheduled_at: Math.floor(due / 1000) } } });
  },
};
