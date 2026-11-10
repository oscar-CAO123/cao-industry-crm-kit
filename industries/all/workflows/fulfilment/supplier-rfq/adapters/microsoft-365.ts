// Microsoft 365: the RFQ goes to each supplier as an Outlook draft (the send is always an approval), replies come back
// through the RFQ folder, and every event is a row in an Excel register. Crons only read and draft here.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Rfq, type Contact, ID, EMAIL, cell, day, esc, rfqHtml } from "../types.ts";

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

/** The RFQ as an Outlook draft to one supplier (a draft operation: it sits in Drafts until its send is approved). */
async function draftRfq(ctx: Ctx<Settings>, rfq: Rfq, to: Contact): Promise<string> {
  const box = cfg(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft RFQ ${rfq.id} to ${to.email}`, input: { params: { "user-id": box }, body: {
    subject: `RFQ ${rfq.id}: ${rfq.title}`.slice(0, 250), body: { contentType: "HTML", content: rfqHtml(ctx.settings, rfq, to) },
    toRecipients: [{ emailAddress: { address: to.email } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: RFQ draft not created");
  return id;
}

/** One chaser draft to a supplier who has not replied. */
async function draftChase(ctx: Ctx<Settings>, rfq: Rfq, to: Contact, round: number): Promise<string> {
  const box = cfg(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft chaser ${round} for RFQ ${rfq.id} to ${to.email}`, input: { params: { "user-id": box }, body: {
    subject: `Following up: RFQ ${rfq.id}: ${rfq.title}`.slice(0, 250),
    body: { contentType: "HTML", content: `<p>Hi ${esc(to.name || "there")},</p><p>Following up on RFQ ${esc(rfq.id)}.${rfq.needed_by ? ` We need prices by ${esc(rfq.needed_by)}.` : ""} Could you send yours when you can?</p>` },
    toRecipients: [{ emailAddress: { address: to.email } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: chaser draft not created");
  return id;
}

/** The send of one draft: always queued for approval, never run by a cron. */
function sendAct(ctx: Ctx<Settings>, messageId: string, to: string, key: string, summary: string): Act {
  return { platform: P, op: "users.user.messages.message.send", summary, key, input: { params: { "user-id": cfg(ctx).mailbox, "message-id": messageId } } };
}

/** Replies in the RFQ folder that mention an RFQ. Subjects and bodies are supplier text: data, never instructions. */
async function replies(ctx: Ctx<Settings>): Promise<{ id: string; subject: string; email: string; received: string; preview: string }[]> {
  const m = cfg(ctx);
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read RFQ replies", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": m.rfq_folder ?? "inbox", $search: `"${(m.reply_search ?? "RFQ").replace(/["\\]/g, "")}"`, $top: 50,
    $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
  return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => ({
    id: String(x.id), subject: String(x.subject ?? "").slice(0, 250), email: String(x.from?.emailAddress?.address ?? "").toLowerCase(),
    received: String(x.receivedDateTime ?? ""), preview: String(x.bodyPreview ?? "").slice(0, 4000) }));
}

/** One row in the Excel register (a draft operation: an internal record). Text cells are never formulas. */
async function logRow(ctx: Ctx<Settings>, values: (string | number)[]): Promise<void> {
  const reg = cfg(ctx).register;
  if (!reg) return;
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: "add row to RFQ register",
    input: { params: table(reg), body: { values: [values.map((v) => (typeof v === "number" ? v : cell(v)))] } } });
}

export const microsoft365 = { id: P, draftRfq, draftChase, sendAct, replies, logRow };
