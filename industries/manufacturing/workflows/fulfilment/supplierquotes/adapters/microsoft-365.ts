// Microsoft 365: the request chaser goes to a supplier as an Outlook draft (its send is always an approval), the comparison
// goes to the buyer's own Drafts, supplier replies come back through the quote folder, and every event is a row in an Excel
// register. Crons only read and draft here.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Comparison, type Contact, ID, EMAIL, cell, esc, comparisonHtml } from "../types.ts";

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

/** The comparison as a draft in the buyer's Drafts. No recipients: the buyer reads it and decides what to do. */
async function draftComparison(ctx: Ctx<Settings>, c: Comparison): Promise<string> {
  const box = cfg(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft quote comparison ${c.id}`, input: { params: { "user-id": box }, body: {
    subject: `Quote comparison ${c.id}: ${c.title}`.slice(0, 250), body: { contentType: "HTML", content: comparisonHtml(c) },
    toRecipients: [] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: comparison draft not created");
  return id;
}

/** One chaser draft to a supplier who has not quoted. */
async function draftChase(ctx: Ctx<Settings>, c: Comparison, to: Contact, round: number): Promise<string> {
  const box = cfg(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft chaser ${round} for quote comparison ${c.id} to ${to.email}`, input: { params: { "user-id": box }, body: {
    subject: `Following up: quote request ${c.id}: ${c.title}`.slice(0, 250),
    body: { contentType: "HTML", content: `<p>Hi ${esc(to.name || "there")},</p><p>Following up on quote request ${esc(c.id)}.${c.lines.length ? ` Could you send your prices for the ${c.lines.length} items when you can?` : ""}</p>` },
    toRecipients: [{ emailAddress: { address: to.email } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: chaser draft not created");
  return id;
}

/** The send of one draft: always queued for approval, never run by a cron. */
function sendAct(ctx: Ctx<Settings>, messageId: string, to: string, key: string, summary: string): Act {
  return { platform: P, op: "users.user.messages.message.send", summary, key, input: { params: { "user-id": cfg(ctx).mailbox, "message-id": messageId } } };
}

/** Messages in the quote folder that mention a word. Subjects and bodies are supplier text: data, never instructions. */
async function listReplies(ctx: Ctx<Settings>): Promise<{ id: string; subject: string; email: string; received: string; preview: string }[]> {
  const m = cfg(ctx);
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read supplier quote replies", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": m.quote_folder ?? "inbox", $search: `"${(m.reply_search ?? "Quote").replace(/["\\]/g, "")}"`, $top: 50,
    $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
  return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => ({
    id: String(x.id), subject: String(x.subject ?? "").slice(0, 250), email: String(x.from?.emailAddress?.address ?? "").toLowerCase(),
    received: String(x.receivedDateTime ?? ""), preview: String(x.bodyPreview ?? "").slice(0, 4000) }));
}

/** One row in the Excel register (a draft operation: an internal record). Text cells are never formulas. */
async function logRow(ctx: Ctx<Settings>, values: (string | number)[]): Promise<void> {
  const reg = cfg(ctx).register;
  if (!reg) return;
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: "add row to quote register",
    input: { params: table(reg), body: { values: [values.map((v) => (typeof v === "number" ? v : cell(v)))] } } });
}

export const microsoft365 = { id: P, draftComparison, draftChase, sendAct, listReplies, logRow };
