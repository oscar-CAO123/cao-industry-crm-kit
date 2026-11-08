// Microsoft 365: the enquiries folder (Outlook), the document request as an Outlook draft, and the loan register
// (an Excel table). Only the operations in workflow.json are called. The send is returned as an act for the caller to queue.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Enquiry, type Settings, EMAIL, esc, cell, day } from "../types.ts";

const P = "microsoft-365" as const;
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
const keyOf = (s: string) => safeKey(s, 90);
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  return m;
};
const table = (t: { drive: string; item: string; table: string }) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

/** Loan enquiries in the folder (a read). */
export async function enquiries(ctx: Ctx<Settings>): Promise<Omit<Enquiry, "status">[]> {
  const m = cfg(ctx);
  const word = (m.search ?? "loan").replace(/[^A-Za-z0-9 ]/g, "").slice(0, 60) || "loan";
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read loan enquiries", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $search: `"${word}"`, $top: 25,
    $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
  return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => ({
    id: keyOf(`m365:${x.id}`), source: P, title: String(x.subject ?? "Loan enquiry").slice(0, 120),
    text: String(x.bodyPreview ?? "").slice(0, 4000),
    contact: { name: String(x.from?.emailAddress?.name ?? "").slice(0, 120) || undefined,
               email: EMAIL.test(x.from?.emailAddress?.address ?? "") ? x.from.emailAddress.address : undefined },
    received: String(x.receivedDateTime ?? ctx.now.toISOString()), ref: { message_id: x.id } }));
}

/** One row in the loan register (an internal record, a draft operation). */
export async function registerRow(ctx: Ctx<Settings>, e: Enquiry, status: string): Promise<void> {
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: "add to loan register", input: {
    params: table(cfg(ctx).register),
    body: { values: [[day(ctx.now), cell(e.id), cell(e.contact.name ?? ""), cell(e.contact.email ?? ""), cell(e.title), cell(status)]] } } });
}

/** The document request as an Outlook draft (a draft operation). Returns the send act for the caller to queue. */
export async function documentRequest(ctx: Ctx<Settings>, e: Enquiry): Promise<{ messageId: string; act: Act }> {
  const m = cfg(ctx), to = e.contact.email;
  if (!to || !EMAIL.test(to)) throw new Error("microsoft-365: bad recipient");
  const items = (ctx.settings.documents ?? []).map((d) => `<li>${esc(d)}</li>`).join("");
  const html = `<p>Hi ${esc(e.contact.name ?? "there")},</p><p>Thanks for your enquiry. To start your loan application, please send us these documents:</p><ul>${items}</ul><p>Thanks, ${esc(ctx.settings.business_name ?? "")}</p>`;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft document request to ${to}`, input: {
    params: { "user-id": m.mailbox },
    body: { subject: "Documents for your loan enquiry", body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send document request to ${to}`,
    input: { params: { "user-id": m.mailbox, "message-id": id } } } };
}
