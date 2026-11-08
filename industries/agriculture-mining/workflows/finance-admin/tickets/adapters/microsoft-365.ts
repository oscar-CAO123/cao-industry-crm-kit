// Microsoft 365 for the delivery tickets workflow: docket emails in from the ticket mailbox (subject and sender only,
// never the body), register and QC rows in the business's own Excel tables, and the QC email as an Outlook draft.
// Sending that draft is always an approval.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Table, EMAIL, GRAPH_ID, text } from "../types.ts";

const P = "microsoft-365";
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox (the client's own) is not set");
  return m;
};
const table = (t: Table) => {
  for (const v of [t.drive, t.item, t.table]) if (!GRAPH_ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

/** Docket emails in the ticket mailbox: id, subject and received time. The body is not read here. */
export async function dockets(ctx: Ctx<Settings>): Promise<{ id: string; subject: string; received: string }[]> {
  const m = cfg(ctx);
  const word = (m.search ?? "docket").replace(/["\\]/g, "").slice(0, 60) || "docket";
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read docket emails", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $search: `"${word}"`, $top: 25, $select: "id,subject,receivedDateTime" } } });
  return (r.data?.value ?? []).filter((x: any) => GRAPH_ID.test(String(x.id ?? ""))).map((x: any) => ({
    id: String(x.id), subject: text(x.subject, 120), received: String(x.receivedDateTime ?? ctx.now.toISOString()) }));
}

/** Append rows to one of the business's own Excel tables (a draft operation: an internal log). */
export async function addRows(ctx: Ctx<Settings>, t: Table, values: unknown[][], what: string) {
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: what, input: { params: table(t), body: { values } } });
}

/** Create the QC email as an Outlook draft and return the send act, for the caller to queue for approval. */
export async function mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; act: Act }> {
  if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
  const box = cfg(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${m.to}`, input: { params: { "user-id": box }, body: {
    subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!GRAPH_ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${m.to}`, input: { params: { "user-id": box, "message-id": id } } } };
}
