// Microsoft 365: buyer enquiries from an Outlook folder, an optional price list in an Excel table, the register
// the forecasts are logged to (an Excel table), and the monthly summary as an Outlook draft. Sending a draft
// is always an approval: this adapter returns the send act, and the cron queues it.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Enquiry, type Item, type Settings, type Table, EMAIL, ID, cell, keyOf } from "../types.ts";

const P = "microsoft-365";

function box(ctx: Ctx<Settings>) {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox (the client's own) is not set");
  return m;
}
function table(t: Table) {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
}

/** Buyer enquiries from the folder: messages whose subject or preview carries the search word, newest first. */
export async function enquiries(ctx: Ctx<Settings>): Promise<Enquiry[]> {
  const m = box(ctx);
  const word = (m.search ?? "order").replace(/["\\]/g, "").slice(0, 60) || "order";
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read buyer enquiries", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $search: `"${word}"`, $top: 25,
    $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
  return (Array.isArray(r.data?.value) ? r.data.value : []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any): Enquiry => ({
    id: keyOf(`m365:${x.id}`),
    title: String(x.subject ?? "Buyer enquiry").slice(0, 120),
    from: EMAIL.test(x.from?.emailAddress?.address ?? "") ? String(x.from.emailAddress.address) : "",
    received: String(x.receivedDateTime ?? ""),
    preview: String(x.bodyPreview ?? "").slice(0, 1000),
  }));
}

/** The price list as Code | Name | Unit | Price rows. */
export async function priceTable(ctx: Ctx<Settings>, t: Table): Promise<Item[]> {
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read price list", input: { params: table(t) } });
  return (Array.isArray(r.data?.value) ? r.data.value : []).map((row: any) => row.values?.[0] ?? [])
    .filter((v: any[]) => v[0] && Number.isFinite(Number(v[3])))
    .map((v: any[]): Item => ({ code: String(v[0]).slice(0, 60), name: String(v[1] ?? v[0]).slice(0, 120), price: Number(v[3]) }));
}

/** Append rows to a register table (an internal log: a draft operation). */
export async function appendRows(ctx: Ctx<Settings>, t: Table, rows: unknown[][], summary: string): Promise<void> {
  const values = rows.map((row) => row.map((v) => (typeof v === "string" ? cell(v) : v)));
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary, input: { params: table(t), body: { values } } });
}

/** An Outlook draft from the client's mailbox, plus the send act for the caller to queue for approval. */
export async function mailDraft(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<{ messageId: string; send: Act }> {
  if (!EMAIL.test(to)) throw new Error("microsoft-365: bad recipient");
  const user = box(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${to}`, input: { params: { "user-id": user }, body: {
    subject: subject.replace(/[\r\n]+/g, " ").slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, send: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${to}`, input: { params: { "user-id": user, "message-id": id } } } };
}
