// Microsoft 365: subcontractor replies from an Outlook folder, the Subcontractors register (an Excel table), and Outlook
// drafts. A draft is never sent here: the send is returned as an act, and the cron queues it for a person to approve.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Row, EMAIL, ID, cell, rowOf } from "../types.ts";

const P = "microsoft-365";
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set or is not an address");
  return m;
};
const tableOf = (ctx: Ctx<Settings>) => {
  const t = cfg(ctx).register;
  if (!t) throw new Error("microsoft_365.register is not set");
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

export interface Reply { messageId: string; name: string; email: string; subject: string; received: string }

/** Replies from subcontractors in the Outlook folder (a read). */
export async function replies(ctx: Ctx<Settings>): Promise<Reply[]> {
  const m = cfg(ctx);
  const word = (m.search ?? "certificate").replace(/["\\]/g, "").slice(0, 60);
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read subcontractor replies", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $search: `"${word}"`, $top: 25, $select: "id,subject,from,receivedDateTime" } } });
  const out: Reply[] = [];
  for (const x of r.data?.value ?? []) {
    const address = String(x?.from?.emailAddress?.address ?? "");
    if (!ID.test(String(x?.id ?? "")) || !EMAIL.test(address)) continue;
    out.push({
      messageId: String(x.id), name: String(x.from?.emailAddress?.name ?? "").slice(0, 120), email: address,
      subject: String(x.subject ?? "").slice(0, 120), received: String(x.receivedDateTime ?? ""),
    });
  }
  return out;
}

/** Every row of the register (a read). */
export async function register(ctx: Ctx<Settings>): Promise<Row[]> {
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read the subcontractor register", input: { params: tableOf(ctx) } });
  return (r.data?.value ?? []).map((row: any) => rowOf(Array.isArray(row?.values?.[0]) ? row.values[0] : []));
}

/** Add one row to the register (an internal record, so a draft operation). */
export async function addRow(ctx: Ctx<Settings>, row: Row): Promise<void> {
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: `register row for ${row.subcontractor}`, input: {
    params: tableOf(ctx), body: { values: [[row.subcontractor, row.email, row.trade, row.document, row.expiry, row.status].map(cell)] } } });
}

/** An Outlook draft to one address (a draft operation). Returns the send, for the caller to queue for approval. */
export async function mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; send: Act }> {
  if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
  const box = cfg(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${m.to}`, input: { params: { "user-id": box }, body: {
    subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, send: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${m.to}`, input: { params: { "user-id": box, "message-id": id } } } };
}
