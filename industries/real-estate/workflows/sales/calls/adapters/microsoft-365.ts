// Microsoft 365 (Graph): the first-call and chaser emails. The email is created as an Outlook draft in the agency's own
// mailbox (a draft operation). Its send is returned as a live act for the caller to queue; nothing is sent here.
// Field names from the Graph v1.0 spec: users.CreateMessages takes user-id and a message body with subject, body
// {contentType, content} and toRecipients[].emailAddress.address; users.user.messages.message.send takes user-id and message-id.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, EMAIL } from "../types.ts";

export const P = "microsoft-365";
const ID = /^[A-Za-z0-9][A-Za-z0-9=_\-!.]{0,399}$/;

export function mailbox(ctx: Ctx<Settings>): string {
  const box = ctx.settings.microsoft_365?.mailbox;
  if (!box || !EMAIL.test(box)) throw new Error("microsoft_365.mailbox (the agency's own) is not set");
  return box;
}

/** Create the email as an Outlook draft, and return its id with the send act for the caller to queue for approval. */
export async function emailDraft(ctx: Ctx<Settings>, to: string, subject: string, html: string, key: string): Promise<{ messageId: string; act: Act }> {
  if (!EMAIL.test(to)) throw new Error("microsoft-365: bad recipient");
  const box = mailbox(ctx);
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${to}`, input: { params: { "user-id": box }, body: {
    subject: subject.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${to}`, key,
    input: { params: { "user-id": box, "message-id": id } } } };
}
