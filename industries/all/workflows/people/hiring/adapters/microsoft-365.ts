// Microsoft 365: where most small businesses already take applications. Applications arrive in an Outlook folder,
// the candidate register is an Excel table (Date | Applicant | Email | Role | Source | Status), and every reply is an
// Outlook draft. Sending a draft is always an approval, never a cron.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Applicant, type Settings, EMAIL, cell, day, keyOf } from "../types.ts";

const P = "microsoft-365";
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;

const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox (the business's own) is not set");
  return m;
};
const table = (t: { drive: string; item: string; table: string }) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};
/** The role an application is for, read from its subject line: "Application: AI Officer" becomes "AI Officer". */
const roleFrom = (subject: string) => subject.replace(/^((re|fw|fwd)\s*:\s*)+/i, "").replace(/^(application|applying|apply)\s*(for)?\s*[:\-]?\s*/i, "").trim().slice(0, 120);

export const microsoft365 = {
  id: P,
  /** Applications that arrived since the last run: a read only. Attachments (CVs) are not read: the attachment list is not mapped. */
  async applications(ctx: Ctx<Settings>): Promise<Omit<Applicant, "stage">[]> {
    const m = cfg(ctx);
    const word = (m.search ?? "application").replace(/["\\]/g, "").slice(0, 60) || "application";
    const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read applications", input: { params: {
      "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $search: `"${word}"`, $top: 25,
      $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
    return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => {
      const subject = String(x.subject ?? "");
      const email = x.from?.emailAddress?.address;
      return {
        id: keyOf(`m365:${x.id}`), source: P as const,
        name: String(x.from?.emailAddress?.name ?? "").slice(0, 120) || "Applicant",
        email: EMAIL.test(email ?? "") ? String(email) : undefined,
        role: roleFrom(subject) || "the role",
        text: String(x.bodyPreview ?? "").slice(0, 4000),
        received: String(x.receivedDateTime ?? ctx.now.toISOString()),
        ref: { message_id: String(x.id) },
      };
    });
  },
  /** One row in the candidate register on arrival (a draft operation: an internal record, nobody outside sees it). */
  async registerRow(ctx: Ctx<Settings>, a: Applicant): Promise<void> {
    const reg = cfg(ctx).register;
    if (!reg) return;
    await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: `register ${a.name} for ${a.role}`,
      input: { params: table(reg), body: { values: [[day(ctx.now), cell(a.name), cell(a.email ?? ""), cell(a.role), cell(P), "New"]] } } });
  },
  /** Create the reply as an Outlook draft (a draft operation) and return the send act, for the caller to queue for approval. */
  async replyDraft(ctx: Ctx<Settings>, to: string, subject: string, html: string): Promise<{ messageId: string; act: Act }> {
    if (!EMAIL.test(to)) throw new Error("microsoft-365: bad recipient");
    const box = cfg(ctx).mailbox;
    const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft reply to ${to}`, input: { params: { "user-id": box }, body: {
      subject: subject.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
    const id = String(r.data?.id ?? "");
    if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
    return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send reply to ${to}`, input: { params: { "user-id": box, "message-id": id } } } };
  },
};
