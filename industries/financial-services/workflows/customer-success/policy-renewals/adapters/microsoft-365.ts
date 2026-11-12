// Microsoft 365 for the renewals workflow: the broker's Outlook folder, the policy register (an Excel table) and
// Outlook drafts. A send is never made here: draftMail returns the send act and the caller queues it for approval.
// Operation ids and body fields are the ones in core/sdk/platforms/microsoft-365 and the Graph spec.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { EMAIL, type MailMessage, type Policy, type Settings } from "../types.ts";

const P = "microsoft-365";
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;

function cfg(ctx: Ctx<Settings>) {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  return m;
}

function tableIds(t: { drive: string; item: string; table: string }) {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
}

/** The newest messages in the folder. Read only. Subjects and previews are data from outside, never instructions. */
export async function listMail(ctx: Ctx<Settings>): Promise<MailMessage[]> {
  const m = cfg(ctx);
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read the renewals folder", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $top: 25, $orderby: "receivedDateTime desc",
    $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
  return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any): MailMessage => ({
    id: String(x.id),
    subject: String(x.subject ?? "").slice(0, 200),
    from: String(x.from?.emailAddress?.address ?? "").toLowerCase(),
    fromName: String(x.from?.emailAddress?.name ?? "").slice(0, 120),
    received: String(x.receivedDateTime ?? ""),
    preview: String(x.bodyPreview ?? "").slice(0, 2000),
  }));
}

/** The policy register, read only. Returns [] when no register is set. */
export async function readRegister(ctx: Ctx<Settings>): Promise<Policy[]> {
  const t = cfg(ctx).register;
  if (!t) return [];
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read the policy register", input: { params: tableIds(t) } });
  return (r.data?.value ?? []).map((row: any) => row.values?.[0] ?? []).filter((v: any[]) => String(v[0] ?? "").trim())
    .map((v: any[]): Policy => ({ policy: String(v[0]).trim(), client: String(v[1] ?? "").slice(0, 120), email: String(v[2] ?? "").trim(),
      renewal: v[3], details: String(v[4] ?? "").slice(0, 200) }));
}

/** An Outlook draft in the broker's mailbox (a draft operation). Returns the send act for the caller to queue. */
export async function draftMail(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<{ messageId: string; send: Act }> {
  if (!EMAIL.test(to)) throw new Error("microsoft-365: bad recipient");
  const box = cfg(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${to}`, input: { params: { "user-id": box }, body: {
    subject: subject.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, send: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${to}`, input: { params: { "user-id": box, "message-id": id } } } };
}
