// Microsoft 365, the one platform this workflow can call: finished-part requests from an Outlook folder, a check register
// as an Excel table, and result emails as Outlook drafts. Sending a draft is always an approval.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Check, type Contact, EMAIL, ID, keyOf, esc, cell, day, DECISION_TEXT } from "../types.ts";

const P = "microsoft-365";
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  return m;
};
const register = (ctx: Ctx<Settings>) => {
  const t = cfg(ctx).register;
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};
const contactOf = (x: any): Contact => {
  const addr = x.from?.emailAddress?.address;
  return { name: String(x.from?.emailAddress?.name ?? "").slice(0, 120) || undefined, email: EMAIL.test(addr ?? "") ? addr : undefined };
};

/** Finished-part requests that arrived in the request folder (a read). */
export async function requests(ctx: Ctx<Settings>): Promise<Omit<Check, "status">[]> {
  const m = cfg(ctx);
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read finished-part requests", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $search: `"${(m.search ?? "photo").replace(/["\\]/g, "")}"`, $top: 25,
    $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
  return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => ({
    id: keyOf(`m365:${x.id}`), source: P as const, title: String(x.subject ?? "Finished-part check").slice(0, 120),
    text: String(x.bodyPreview ?? "").slice(0, 4000), contact: contactOf(x),
    received: String(x.receivedDateTime ?? ctx.now.toISOString()), ref: { message_id: String(x.id) } }));
}

/** One row in the check register (a draft operation). Returns the row index the workbook gives back. */
export async function logRow(ctx: Ctx<Settings>, c: Check): Promise<number> {
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: `log check ${c.id.slice(0, 20)} in register`, input: {
    params: register(ctx), body: { values: [[day(ctx.now), cell(c.id), cell(c.title), cell(c.contact.name ?? ""), cell(c.contact.email ?? ""), "Awaiting photo check"]] } } });
  return Number(r.data?.index ?? -1);
}

/** The result email as an Outlook draft (a draft operation). Returns the draft's message id. Nothing is sent here. */
export async function draftResult(ctx: Ctx<Settings>, c: Check): Promise<string> {
  const to = c.contact.email;
  if (!to || !EMAIL.test(to)) throw new Error("photocheck: no valid customer email");
  if (!c.result) throw new Error("photocheck: no result recorded");
  const html = `<p>Hi ${esc(c.contact.name ?? "there")},</p><p>${esc(DECISION_TEXT[c.result.decision])}</p>`
    + `<p>${esc(c.result.note.slice(0, 1000))}</p><p>${esc(ctx.settings.business_name ?? "")}</p>`;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft result email to ${to}`, input: { params: { "user-id": cfg(ctx).mailbox }, body: {
    subject: `Result of your finished-part check: ${c.title}`.slice(0, 250), body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return id;
}

/** The approval act that sends an existing draft. Only a person's approval runs it. */
export function sendAct(ctx: Ctx<Settings>, c: Check, messageId: string): Act {
  return { platform: P, op: "users.user.messages.message.send", summary: `send result email to ${c.contact.email}: ${c.result?.decision}`,
    input: { params: { "user-id": cfg(ctx).mailbox, "message-id": messageId } }, key: `send:${c.id}` };
}
