// Microsoft 365: the compliance mailbox that regulators write to, and an Excel register of lodgements.
// Reads the mailbox and the register, writes register rows and Outlook drafts (both internal), and returns the send
// act for the caller to queue. Nothing here sends.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Notice, EMAIL, ID, cell, day, esc, keyOf } from "../types.ts";

const P = "microsoft-365";
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  if (!EMAIL.test(ctx.settings.owner_email ?? "")) throw new Error("owner_email is not set");
  return m;
};
const table = (t: { drive: string; item: string; table: string }) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

/** Regulator notices that arrived in the mailbox folder (read only). */
export async function notices(ctx: Ctx<Settings>): Promise<Omit<Notice, "status">[]> {
  const m = cfg(ctx);
  const q = (m.search ?? "").replace(/["\\]/g, "").trim();
  const params: Record<string, unknown> = { "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $top: 25, $select: "id,subject,from,receivedDateTime,bodyPreview" };
  if (q) params.$search = `"${q}"`;
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read regulator notices", input: { params } });
  return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => ({
    id: keyOf(`m365:${x.id}`), title: String(x.subject ?? "Regulator notice").slice(0, 200), text: String(x.bodyPreview ?? "").slice(0, 4000),
    from: String(x.from?.emailAddress?.address ?? "").slice(0, 190) || undefined,
    received: String(x.receivedDateTime ?? ctx.now.toISOString()), ref: { message_id: String(x.id) },
  }));
}

/** Every row of the lodgement register, as its cell values (Date | Key | Notice | From | Due | Status). */
export async function registerRows(ctx: Ctx<Settings>): Promise<string[][]> {
  const t = cfg(ctx).register;
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read lodgement register", input: { params: table(t) } });
  return (r.data?.value ?? []).map((row: any) => (row.values?.[0] ?? []).map((v: unknown) => String(v ?? "")));
}

/** Add one register row, every text cell kept from becoming a formula. */
export async function addRegisterRow(ctx: Ctx<Settings>, n: Notice): Promise<void> {
  const t = cfg(ctx).register;
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: `register ${n.title}`, input: { params: table(t), body: {
    values: [[day(ctx.now), cell(n.id), cell(n.title), cell(n.from ?? ""), cell(n.due ?? ""), "Open"]] } } });
}

/** An internal Outlook draft to the owner, in the compliance mailbox. Returns the message id and the send act to queue. */
export async function ownerDraft(ctx: Ctx<Settings>, subject: string, html: string): Promise<{ messageId: string; act: Act }> {
  const m = cfg(ctx), to = ctx.settings.owner_email;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `owner draft: ${subject.slice(0, 80)}`, input: { params: { "user-id": m.mailbox }, body: {
    subject: subject.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send to ${to}: ${subject.slice(0, 80)}`, input: { params: { "user-id": m.mailbox, "message-id": id } } } };
}

/** The internal note for a new notice, as escaped HTML. */
export function noticeHtml(n: Notice, business: string): string {
  const due = n.due ? `Due ${esc(n.due)}.` : "No due date is set for this type of notice. Add one in the lodgement register.";
  return `<p>New regulator notice for ${esc(business)}: <b>${esc(n.title)}</b></p><p>From: ${esc(n.from ?? "unknown")}</p>`
    + `<p>${due}</p><p>Preview: ${esc(n.text ?? "")}</p><p>A person lodges, answers and marks it done. Nothing has been sent to the regulator.</p>`;
}
