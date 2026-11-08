// Microsoft 365: walkthrough emails with video links are read from a mailbox folder, and training emails are drafted in
// Outlook. Sending a draft is always an approval; a cron never sends.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Source, EMAIL, keyOf } from "../types.ts";

const P = "microsoft-365";
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox (the business's own) is not set");
  return m;
};

export const microsoft365 = {
  id: P,
  /** Walkthrough emails from the mailbox folder that match the search words. */
  async sources(ctx: Ctx<Settings>): Promise<Omit<Source, "status">[]> {
    const m = cfg(ctx);
    const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read walkthrough emails", input: { params: {
      "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $search: `"${(m.search ?? "walkthrough").replace(/["\\]/g, "")}"`, $top: 25,
      $select: "id,subject,receivedDateTime,bodyPreview" } } });
    return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => ({
      id: keyOf(`m365:${x.id}`), platform: P, kind: "walkthrough" as const, title: String(x.subject ?? "Walkthrough").slice(0, 200),
      text: String(x.bodyPreview ?? "").slice(0, 4000), received: String(x.receivedDateTime ?? ctx.now.toISOString()), ref: { message_id: String(x.id) } }));
  },
  /** An Outlook draft to a trainee (a draft operation), and the act that sends it, for the caller to queue. */
  async mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; act: Act }> {
    if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
    const box = cfg(ctx).mailbox;
    const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft training email to ${m.to}`, input: { params: { "user-id": box }, body: {
      subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
    const id = String(r.data?.id ?? "");
    if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
    return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send training email to ${m.to}`, input: { params: { "user-id": box, "message-id": id } } } };
  },
};
