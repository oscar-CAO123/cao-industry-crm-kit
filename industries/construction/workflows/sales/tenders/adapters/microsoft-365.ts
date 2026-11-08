// Microsoft 365: where tender notices arrive and get logged. Notices come from an Outlook folder, the register is an
// Excel table, and every email is an Outlook draft. Sending a draft is always an approval, queued by the caller.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Tender, type RegisterRow, type Table, ID, REF, EMAIL, keyOf, cell, day } from "../types.ts";

const P = "microsoft-365";

const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox (the business's own) is not set");
  if (!m.register) throw new Error("microsoft_365.register (the tender register table) is not set");
  return m;
};
const table = (t: Table) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};
/** An Excel date cell comes back as a serial number when the owner types a date; turn it into YYYY-MM-DD. */
const closesText = (v: unknown) => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  return String(v ?? "").trim().slice(0, 10);
};

/** Tender notices that reached the folder (a draft operation: a read). */
export async function notices(ctx: Ctx<Settings>): Promise<Omit<Tender, "status">[]> {
  const m = cfg(ctx);
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read tender notices", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $search: `"${(m.search ?? "tender").replace(/["\\]/g, "")}"`, $top: 25,
    $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
  return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => ({
    ref: keyOf(`m365:${x.id}`), title: String(x.subject ?? "Tender notice").slice(0, 120), text: String(x.bodyPreview ?? "").slice(0, 4000),
    principal: { name: String(x.from?.emailAddress?.name ?? "").slice(0, 120) || undefined,
                 email: EMAIL.test(x.from?.emailAddress?.address ?? "") ? x.from.emailAddress.address : undefined },
    received: String(x.receivedDateTime ?? ctx.now.toISOString()) }));
}

/** Log a new tender as a row in the register (an internal record: a draft operation). The owner sets Go or No-go. */
export async function logTender(ctx: Ctx<Settings>, t: Omit<Tender, "status">): Promise<void> {
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: `log tender ${t.title}`, input: {
    params: table(cfg(ctx).register),
    body: { values: [[day(ctx.now), cell(t.ref), cell(t.title), cell(t.principal.name ?? ""), cell(t.principal.email ?? ""), "", "Check go or no-go"]] } } });
}

/** Every row of the register, read fresh (a draft operation: a read). Rows whose ref is not well formed are dropped. */
export async function registerRows(ctx: Ctx<Settings>): Promise<RegisterRow[]> {
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read tender register", input: { params: table(cfg(ctx).register) } });
  return (r.data?.value ?? []).map((row: any) => (row.values?.[0] ?? []) as unknown[]).map((v) => ({
    ref: String(v[1] ?? "").trim(), tender: String(v[2] ?? "").slice(0, 120), principal: String(v[3] ?? "").slice(0, 120),
    email: String(v[4] ?? "").trim(), closes: closesText(v[5]), status: String(v[6] ?? "").trim().slice(0, 40) }))
    .filter((x) => REF.test(x.ref));
}

/** An Outlook draft to one recipient (a draft operation). Returns the draft's id and mailbox for the caller to queue its send. */
export async function mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; box: string }> {
  if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
  const box = cfg(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${m.to}`, input: { params: { "user-id": box }, body: {
    subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, box };
}

/** The live act that sends an approved Outlook draft. Only ever queued, never run by a cron. */
export const sendAct = (box: string, messageId: string, summary: string, key?: string) =>
  ({ platform: P, op: "users.user.messages.message.send", summary, key, input: { params: { "user-id": box, "message-id": messageId } } });
