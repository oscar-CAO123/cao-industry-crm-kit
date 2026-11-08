// Microsoft 365, for a dealer that keeps its stock list and PPSR register in Excel and its mail in Outlook.
// Field names from the Microsoft Graph v1.0 spec: workbookTableRow.values, and message (subject, body, toRecipients).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Table, EMAIL, ID, cell } from "../types.ts";

const P = "microsoft-365";
const ids = (t: Table) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

/** The first 1,000 rows of a table, each as its array of cell values. */
export async function tableRows(ctx: Ctx<Settings>, t: Table): Promise<any[][]> {
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: `read ${t.table}`, input: { params: { ...ids(t), $top: 1000 } } });
  return (r.data?.value ?? []).map((row: any) => (Array.isArray(row.values?.[0]) ? row.values[0] : []));
}

/** Add rows to a register (an internal record: a draft operation). Formula-looking cells are neutralised. */
export async function appendRows(ctx: Ctx<Settings>, t: Table, rows: unknown[][]): Promise<void> {
  if (!rows.length) return;
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: `add ${rows.length} row(s) to ${t.table}`,
    input: { params: ids(t), body: { values: rows.map((r) => r.map(cell)) } } });
}

/** Create an Outlook draft in the dealer's mailbox and return its id. Nothing leaves the mailbox here. */
export async function draftMail(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<string> {
  if (!EMAIL.test(to)) throw new Error("microsoft-365: bad recipient");
  const box = ctx.settings.microsoft_365.mailbox;
  if (!EMAIL.test(box)) throw new Error("microsoft-365: mailbox is not set");
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${to}`, input: { params: { "user-id": box }, body: {
    subject: subject.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return id;
}

/** The live act that sends a draft. Only ever queued for approval, never run by a cron. */
export const sendAct = (ctx: Ctx<Settings>, messageId: string, summary: string, key: string): Act => ({
  platform: P, op: "users.user.messages.message.send", summary, key,
  input: { params: { "user-id": ctx.settings.microsoft_365.mailbox, "message-id": messageId } },
});
