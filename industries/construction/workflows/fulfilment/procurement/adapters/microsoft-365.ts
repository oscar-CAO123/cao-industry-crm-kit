// Microsoft 365: where supplier quote replies arrive (an Outlook folder), the quote register and checks log (Excel
// tables in the business's workbook), and clarification emails (an Outlook draft; sending it is always an approval).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Table, EMAIL, cell, esc } from "../types.ts";

const P = "microsoft-365";
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;

const table = (t: Table) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};
const mailbox = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.buying_mailbox;
  if (!m || !EMAIL.test(m)) throw new Error("buying_mailbox is not set");
  return m;
};

export interface Reply { id: string; subject: string; from: string; email?: string; received: string; preview: string }

/** Quote replies in the buying mailbox's folder. Subject and preview are supplier text: stored, never followed. */
export async function replies(ctx: Ctx<Settings>): Promise<Reply[]> {
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read quote replies", input: { params: {
    "user-id": mailbox(ctx), "mailFolder-id": ctx.settings.folder ?? "inbox",
    $search: `"${(ctx.settings.search ?? "quote").replace(/["\\]/g, "")}"`, $top: 25,
    $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
  return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any): Reply => ({
    id: String(x.id),
    subject: String(x.subject ?? "Quote reply").slice(0, 200),
    from: String(x.from?.emailAddress?.name ?? "").slice(0, 120) || "Supplier",
    email: EMAIL.test(x.from?.emailAddress?.address ?? "") ? x.from.emailAddress.address : undefined,
    received: String(x.receivedDateTime ?? ctx.now.toISOString()),
    preview: String(x.bodyPreview ?? "").slice(0, 4000),
  }));
}

/** Rows of a table in the business's workbook, as arrays of values. */
export async function rows(ctx: Ctx<Settings>, t: Table): Promise<any[][]> {
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read rows", input: { params: table(t) } });
  return (r.data?.value ?? []).map((row: any) => (Array.isArray(row.values) ? row.values[0] : [])).filter(Array.isArray);
}

/** Append one row to a table. Every value is made safe for a spreadsheet cell. */
export async function appendRow(ctx: Ctx<Settings>, t: Table, values: unknown[]): Promise<void> {
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: `log row to ${t.table}`,
    input: { params: table(t), body: { values: [values.map(cell)] } } });
}

/** An Outlook draft to a supplier, and the send act to queue for approval. */
export async function draftEmail(ctx: Ctx<Settings>, to: string, subject: string, paragraphs: string[]): Promise<{ messageId: string; act: Act }> {
  if (!EMAIL.test(to)) throw new Error("microsoft-365: bad recipient");
  const box = mailbox(ctx);
  const html = paragraphs.map((p) => `<p>${esc(p)}</p>`).join("");
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${to}`, input: { params: { "user-id": box }, body: {
    subject: subject.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${to}`, input: { params: { "user-id": box, "message-id": id } } } };
}
