// Microsoft 365: Outlook drafts in the arrears mailbox, and rows in the arrears register workbook.
// Sending a draft is a live operation: it is returned as an act for the caller to queue, never run here.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, EMAIL, ID, cell } from "../types.ts";

const P = "microsoft-365";

/** Create the Outlook draft (a draft operation) and return the send act for the caller to queue for approval. */
export async function mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; act: Act }> {
  if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
  const box = ctx.settings.microsoft_365?.mailbox;
  if (!box || !EMAIL.test(box)) throw new Error("microsoft-365: microsoft_365.mailbox is not set");
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: "draft reminder", input: { params: { "user-id": box }, body: {
    subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send reminder to ${m.to}`, input: { params: { "user-id": box, "message-id": id } } } };
}

/** One row in the arrears register workbook: an internal record, so a draft operation. Skipped when no register is set. */
export async function registerRow(ctx: Ctx<Settings>, values: (string | number)[]): Promise<void> {
  const t = ctx.settings.register;
  if (!t) return;
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: "add to arrears register", input: { params: { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table },
    body: { values: [values.map((v) => (typeof v === "number" ? v : cell(v)))] } } });
}
