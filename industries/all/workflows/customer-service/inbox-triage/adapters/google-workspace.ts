// Google Workspace (Gmail): the shared mailbox. Reads unread inbox threads, puts a reply in a Gmail draft (a draft
// operation) and queues that draft's send for approval, and labels the thread so a person picks it up.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Sender, ID, EMAIL, keyOf, oneLine } from "../types.ts";

const P = "google-workspace";
const ME = "me";
const header = (msg: any, name: string): string =>
  String((msg?.payload?.headers ?? []).find((h: any) => String(h?.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "");

/** "Sam Lee <sam@example.com>" or a bare address. Only a valid address is kept. */
function senderOf(from: string): Sender {
  const m = from.match(/<([^>]+)>/);
  const addr = (m ? m[1] : from).trim();
  const name = m ? from.slice(0, from.indexOf("<")).replace(/"/g, "").trim() : "";
  return { name: oneLine(name, 120) || undefined, email: EMAIL.test(addr) ? addr : undefined };
}

/** A plain-text reply as a base64url RFC 2822 message. The subject is encoded, so no header can take a line break. */
function mime(to: string, subject: string, text: string): string {
  const enc = (s: string) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
  const body = Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  return Buffer.from([`To: ${to}`, `Subject: ${enc(subject)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64", "", body].join("\r\n"), "utf8").toString("base64url");
}

/** The id of the label to put on a thread. Created once if it does not exist yet. */
async function labelId(ctx: Ctx<Settings>, name: string): Promise<string> {
  const l = await ctx.draft<any>({ platform: P, op: "gmail.users.labels.list", summary: "read labels", input: { params: { userId: ME } } });
  const hit = (l.data?.labels ?? []).find((x: any) => x.name === name);
  if (hit && ID.test(String(hit.id ?? ""))) return String(hit.id);
  const c = await ctx.draft<any>({ platform: P, op: "gmail.users.labels.create", summary: `create label ${name}`,
    input: { params: { userId: ME }, body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } } });
  if (!ID.test(String(c.data?.id ?? ""))) throw new Error("google-workspace: label not created");
  return String(c.data.id);
}

const threadId = (e: { ref: Record<string, string> }) => {
  const id = e.ref.thread_id ?? "";
  if (!ID.test(id)) throw new Error("google-workspace: bad thread id");
  return id;
};

export const googleWorkspace: Adapter = {
  id: P,
  async inbox(ctx) {
    const list = await ctx.draft<any>({ platform: P, op: "gmail.users.threads.list", summary: "read unread inbox threads",
      input: { params: { userId: ME, q: "in:inbox is:unread", maxResults: 25 } } });
    const out: Awaited<ReturnType<Adapter["inbox"]>> = [];
    for (const t of list.data?.threads ?? []) {
      if (!ID.test(String(t.id ?? ""))) continue;
      const th = await ctx.draft<any>({ platform: P, op: "gmail.users.threads.get", summary: "read thread headers",
        input: { params: { userId: ME, id: t.id, format: "metadata" } } });
      const msgs: any[] = th.data?.messages ?? [];
      const first = msgs[0], last = msgs.at(-1);
      if (!first || !last || (last.labelIds ?? []).includes("SENT")) continue;   // the last message is ours: already answered
      out.push({
        id: keyOf(`gmail:${t.id}`), source: P, subject: oneLine(header(first, "Subject"), 200), preview: oneLine(last.snippet, 2000),
        sender: senderOf(header(last, "From")),
        received: new Date(Number(last.internalDate) || ctx.now.getTime()).toISOString(),
        ref: { thread_id: String(t.id), message_id: String(last.id ?? "") },
      });
    }
    return out;
  },
  async queueReply(ctx, e, text) {
    const to = e.sender.email;
    if (!to || !EMAIL.test(to)) throw new Error("google-workspace: no valid address to reply to");
    const subject = `Re: ${oneLine(e.subject, 150) || "your email"}`;
    const d = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft reply to ${to}`,
      input: { params: { userId: ME }, body: { message: { raw: mime(to, subject, text), threadId: threadId(e) } } } });
    const draftId = String(d.data?.id ?? "");
    if (!ID.test(draftId)) throw new Error("google-workspace: draft not created");
    const summary = `Send the Gmail draft reply to ${to} about "${oneLine(e.subject, 80)}"`;
    // Approving sends this exact draft, so a person can edit it in Gmail before approving.
    return ctx.queue({ platform: P, op: "gmail.users.drafts.send", key: `reply:${e.id}`, summary,
      input: { params: { userId: ME }, body: { id: draftId } } }, summary);
  },
  async assign(ctx, e) {
    const name = (ctx.settings.google?.label_name ?? "Needs reply").slice(0, 60);
    const id = await labelId(ctx, name);
    await ctx.draft({ platform: P, op: "gmail.users.threads.modify", summary: `label thread "${name}"`,
      input: { params: { userId: ME, id: threadId(e) }, body: { addLabelIds: [id] } } });
  },
};
