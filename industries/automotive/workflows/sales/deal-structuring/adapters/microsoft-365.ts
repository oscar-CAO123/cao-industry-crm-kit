// Microsoft 365: lender packs go out as Outlook drafts, and the deal register is an Excel table. Sending a draft is
// always an approval (the send act is returned, never run here).
import type { Act } from "../../../../../../core/workflows/runtime.ts";
import { type Cx, EMAIL, ID, cell, day } from "../types.ts";

const P = "microsoft-365";

const cfg = (ctx: Cx) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  return m;
};
const table = (t: { drive: string; item: string; table: string }) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

/** Create an Outlook draft to a lender (a draft operation) and return the send act for approval. */
export async function mailDraft(ctx: Cx, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; act: Act }> {
  if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
  const box = cfg(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${m.to}`, input: { params: { "user-id": box }, body: {
    subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${m.to}`,
    input: { params: { "user-id": box, "message-id": id } } } };
}

/** One row in the deal register (a draft operation: an internal workbook). */
export async function registerRow(ctx: Cx, values: (string | number)[]): Promise<void> {
  const reg = cfg(ctx).register;
  if (!reg) return;
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: "add to deal register",
    input: { params: table(reg), body: { values: [[day(ctx.now), ...values.map(cell)]] } } });
}
