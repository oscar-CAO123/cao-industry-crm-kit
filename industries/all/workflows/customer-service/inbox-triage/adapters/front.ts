// Front: the shared inbox. Reads unassigned open conversations, queues template replies for approval (a send is
// always an approval), assigns the conversation to one teammate and sets the four-hour reminder.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, ID, EMAIL, esc, keyOf, oneLine } from "../types.ts";

const P = "front";
const cfg = (ctx: Ctx<Settings>) => {
  const f = ctx.settings.front;
  if (!f || !ID.test(f.inbox_id ?? "") || !ID.test(f.channel_id ?? "") || !ID.test(f.teammate_id ?? "")) {
    throw new Error("front: inbox_id, channel_id and teammate_id must be set in settings");
  }
  return f;
};
const convId = (e: { ref: Record<string, string> }) => {
  const id = e.ref.conversation_id ?? "";
  if (!ID.test(id)) throw new Error("front: bad conversation id");
  return id;
};

export const front: Adapter = {
  id: P,
  async inbox(ctx) {
    const f = cfg(ctx);
    const r = await ctx.draft<any>({ platform: P, op: "core-api_core-api.list-inbox-conversations", summary: "read shared inbox", input: { params: { inbox_id: f.inbox_id, limit: 25 } } });
    return (r.data?._results ?? [])
      .filter((c: any) => ID.test(String(c.id ?? "")) && !c.is_closed && !c.assignee)
      .map((c: any) => ({
        id: keyOf(`front:${c.id}`), source: P, subject: oneLine(c.subject, 200), preview: oneLine(c.description, 2000),
        sender: { name: oneLine(c.recipient?.name, 120) || undefined, email: EMAIL.test(c.recipient?.handle ?? "") ? c.recipient.handle : undefined },
        received: typeof c.created_at === "number" ? new Date(c.created_at * 1000).toISOString() : ctx.now.toISOString(),
        ref: { conversation_id: String(c.id) },
      }));
  },
  async queueReply(ctx, e, text) {
    const f = cfg(ctx), id = convId(e);
    const html = text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
    const summary = `Reply in Front to ${e.sender.email ?? e.sender.name ?? "the sender"} about "${oneLine(e.subject, 80)}"`;
    return ctx.queue({ platform: P, op: "core-api_core-api.create-message-reply", key: `reply:${e.id}`, summary,
      input: { params: { conversation_id: id }, body: { body: html, channel_id: f.channel_id } } }, summary);
  },
  async assign(ctx, e) {
    const f = cfg(ctx), id = convId(e);
    await ctx.draft({ platform: P, op: "core-api_core-api.update-conversation-assignee", summary: "assign conversation to the teammate",
      input: { params: { conversation_id: id }, body: { assignee_id: f.teammate_id } } });
    // Reminder at the turnaround target. Front only takes a time in the future.
    const due = Math.max(Date.parse(e.received) + (ctx.settings.sla_hours ?? 4) * 3600e3, ctx.now.getTime() + 5 * 60e3);
    await ctx.draft({ platform: P, op: "core-api_core-api.update-conversation-reminders", summary: "set the turnaround reminder",
      input: { params: { conversation_id: id }, body: { teammate_id: f.teammate_id, scheduled_at: Math.floor(due / 1000) } } });
  },
};
