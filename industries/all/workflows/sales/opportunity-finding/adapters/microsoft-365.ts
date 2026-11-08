// Microsoft 365: the alert emails that tender and grant portals send, read from a mail folder; the register as an
// Excel table; the digest as an Outlook draft. Sending the digest is always an approval, never done here.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Opportunity, type Settings, EMAIL, ID, keyOf } from "../types.ts";

const P = "microsoft-365";
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  return m;
};
const table = (t: { drive: string; item: string; table: string }) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

export const microsoft365 = {
  id: P,
  /** Read the alert emails in the folder (a draft operation: a read). Only the preview comes back. */
  async alerts(ctx: Ctx<Settings>): Promise<Omit<Opportunity, "status">[]> {
    const m = cfg(ctx);
    const folder = m.folder ?? "inbox";
    if (!ID.test(folder)) throw new Error("microsoft-365: bad folder id");
    const search = (m.search ?? "").replace(/["\\]/g, "").slice(0, 100);
    const params: Record<string, unknown> = { "user-id": m.mailbox, "mailFolder-id": folder, $top: 25, $select: "id,subject,from,receivedDateTime,bodyPreview" };
    if (search) params.$search = `"${search}"`;
    const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read the alerts folder", input: { params } });
    return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => ({
      key: keyOf(`m365:${x.id}`), platform: P, title: String(x.subject ?? "Opportunity").slice(0, 160),
      preview: String(x.bodyPreview ?? "").slice(0, 2000),
      from: String(x.from?.emailAddress?.name ?? x.from?.emailAddress?.address ?? "").slice(0, 120) || undefined,
      received: String(x.receivedDateTime ?? ctx.now.toISOString()), ref: { message_id: String(x.id) } }));
  },
  /** Append rows to the register table (a draft operation: an internal record). */
  async logRows(ctx: Ctx<Settings>, rows: unknown[][]) {
    const reg = cfg(ctx).register;
    if (!reg) throw new Error("microsoft_365.register is not set");
    return ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: `log ${rows.length} opportunities to the register`,
      input: { params: table(reg), body: { values: rows } } });
  },
  /** Create the digest as an Outlook draft in the business's mailbox and return the send act for the caller to queue. */
  async mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; act: Act }> {
    if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
    const box = cfg(ctx).mailbox;
    const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft digest to ${m.to}`, input: { params: { "user-id": box }, body: {
      subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
    const id = String(r.data?.id ?? "");
    if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
    return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send digest to ${m.to}`,
      input: { params: { "user-id": box, "message-id": id } } } };
  },
};
