// Google Workspace (Gmail): the pitching mailbox. Creates a draft (a draft operation), queues that draft's send for
// approval, and reads a pitch thread to see whether a journalist has replied. Nothing here sends.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Platform, ID, EMAIL, oneLine } from "../types.ts";

export const P: Platform = "google-workspace";
const ME = "me";

/** A plain-text message as a base64url RFC 2822 string. The subject is encoded and lines are wrapped, so no header can take a line break. */
function mime(to: string, subject: string, text: string): string {
  const enc = (s: string) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
  const body = (Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
  return Buffer.from([`To: ${to}`, `Subject: ${enc(subject)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64", "", body].join("\r\n"), "utf8").toString("base64url");
}

/** Create a Gmail draft (a draft operation). A person can edit it in Gmail before its send is approved. */
export async function draftMail(ctx: Ctx<Settings>, m: { to: string; subject: string; text: string; threadId?: string }): Promise<{ draftId: string; threadId: string }> {
  if (!EMAIL.test(m.to)) throw new Error("google-workspace: bad recipient address");
  if (m.threadId !== undefined && !ID.test(m.threadId)) throw new Error("google-workspace: bad thread id");
  const d = await ctx.draft<any>({ platform: P, op: "gmail.users.drafts.create", summary: `draft email to ${m.to}`,
    input: { params: { userId: ME }, body: { message: { raw: mime(m.to, oneLine(m.subject, 200), m.text), ...(m.threadId ? { threadId: m.threadId } : {}) } } } });
  const draftId = String(d.data?.id ?? ""), threadId = String(d.data?.message?.threadId ?? "");
  if (!ID.test(draftId) || !ID.test(threadId)) throw new Error("google-workspace: draft not created");
  return { draftId, threadId };
}

/** Queue the send of an existing draft for approval. Only the approved send reaches a journalist. */
export function queueSend(ctx: Ctx<Settings>, key: string, draftId: string, summary: string): Promise<string> {
  if (!ID.test(draftId)) throw new Error("google-workspace: bad draft id");
  return ctx.queue({ platform: P, op: "gmail.users.drafts.send", key, summary, input: { params: { userId: ME }, body: { id: draftId } } }, summary);
}

/** When a message from outside the business arrived in a pitch thread (INBOX, not our own SENT), or nothing. Read only. */
export async function replyTime(ctx: Ctx<Settings>, threadId: string): Promise<string | undefined> {
  if (!ID.test(threadId)) throw new Error("google-workspace: bad thread id");
  const t = await ctx.draft<any>({ platform: P, op: "gmail.users.threads.get", summary: "check a pitch thread for a reply",
    input: { params: { userId: ME, id: threadId, format: "metadata" } } });
  const incoming = (t.data?.messages ?? []).find((m: any) => (m.labelIds ?? []).includes("INBOX") && !(m.labelIds ?? []).includes("SENT"));
  if (!incoming) return undefined;
  return new Date(Number(incoming.internalDate) || ctx.now.getTime()).toISOString();
}
