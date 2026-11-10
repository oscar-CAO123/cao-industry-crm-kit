// Microsoft 365: the vendor report as an Outlook draft (a draft operation), and the send of that draft (a live operation
// that is only ever queued). Field names follow the Graph message resource used by the construction quoting adapter.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, EMAIL } from "../types.ts";

const P = "microsoft-365";
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
const box = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365?.mailbox;
  if (!m || !EMAIL.test(m)) throw new Error("microsoft_365.mailbox is not set");
  return m;
};

export const microsoft365 = {
  id: P,
  /** Create the Outlook draft and return its id. Nothing is sent. */
  async mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string }): Promise<string> {
    if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
    const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: "draft vendor report",
      input: { params: { "user-id": box(ctx) }, body: {
        subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
    const id = String(r.data?.id ?? "");
    if (!ID.test(id)) throw new Error("microsoft-365: draft returned no message id");
    return id;
  },
  /** The send of a drafted message, as an act for the approval queue. */
  sendAct(ctx: Ctx<Settings>, messageId: string, to: string): Act {
    if (!ID.test(messageId)) throw new Error("microsoft-365: bad message id");
    return { platform: P, op: "users.user.messages.message.send", summary: `send vendor report to ${to}`,
      input: { params: { "user-id": box(ctx), "message-id": messageId } } };
  },
};
