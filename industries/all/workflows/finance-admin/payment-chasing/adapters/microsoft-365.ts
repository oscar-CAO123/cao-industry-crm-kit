// Microsoft 365 (Outlook): where the reminder is written. A reminder is an Outlook draft (a draft operation, made by a cron).
// Sending it is a separate live act that only ever waits in the approval queue.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, EMAIL, plain } from "../types.ts";

const P = "microsoft-365";
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;

function mailbox(ctx: Ctx<Settings>): string {
  if (!EMAIL.test(ctx.settings.mailbox ?? "")) throw new Error("mailbox is not set to a valid address");
  return ctx.settings.mailbox;
}

/** Create the draft in the business mailbox and return its message id. Never sends. */
export async function mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string; attachment?: { name: string; bytes: string } }): Promise<string> {
  if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${m.to}`,
    input: { params: { "user-id": mailbox(ctx) }, body: {
      subject: plain(m.subject, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }],
      ...(m.attachment ? { attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: plain(m.attachment.name, 120),
        contentType: "application/pdf", contentBytes: m.attachment.bytes }] } : {}) } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return id;
}

/** The live act that sends a reminder draft. Queued by the draft cron, run only when a person approves it. */
export function sendAct(ctx: Ctx<Settings>, messageId: string, to: string, key: string): Act {
  if (!ID.test(messageId)) throw new Error("microsoft-365: bad message id");
  return { platform: P, op: "users.user.messages.message.send", key, summary: `send reminder to ${to}`,
    input: { params: { "user-id": mailbox(ctx), "message-id": messageId } } };
}
