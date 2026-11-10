// Microsoft 365: the agency mailbox. Creating an Outlook draft is a draft operation. Sending it is a live operation, queued for approval.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

export const P = "microsoft-365";
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9=_\-!.]{0,399}$/;

/** HTML escaping for anything that goes into a draft body. */
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Create the outreach draft in the agency mailbox, and return the send act for the caller to queue. */
export async function mailDraft(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<{ messageId: string; send: Act }> {
  if (!EMAIL.test(to)) throw new Error("microsoft-365: bad recipient");
  const box = ctx.settings.microsoft_365?.mailbox;
  if (!box || !EMAIL.test(box)) throw new Error("microsoft_365.mailbox is not set");
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft outreach email to ${to}`, input: { params: { "user-id": box }, body: {
    subject: subject.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, send: { platform: P, op: "users.user.messages.message.send", summary: `send outreach email to ${to}`, input: { params: { "user-id": box, "message-id": id } } } };
}
