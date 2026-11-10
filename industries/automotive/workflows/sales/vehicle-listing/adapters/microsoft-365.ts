// Microsoft 365: the stock register and the listing register are Excel tables, photos are a OneDrive folder, and listing
// copy goes out as an Outlook draft. Sending a draft is always an approval (the send act is returned, never run here).
import type { Act } from "../../../../../../core/workflows/runtime.ts";
import { type Cx, type Table, EMAIL, ID, cell, day } from "../types.ts";

const P = "microsoft-365";

const cfg = (ctx: Cx) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  if (!m.stock || !m.photos) throw new Error("microsoft_365.stock and microsoft_365.photos are not set");
  return m;
};
const table = (t: Table) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

/** Every row of the stock register as trimmed text cells, in column order: Stock, Year, Make, Model, Price, Status, PhotoFolderId. */
export async function stockRows(ctx: Cx): Promise<string[][]> {
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read stock register", input: { params: table(cfg(ctx).stock) } });
  return (r.data?.value ?? []).map((row: any) => (Array.isArray(row?.values?.[0]) ? row.values[0] : []))
    .map((c: unknown[]) => c.map((v) => String(v ?? "").trim()));
}

/** How many image files sit in a vehicle's photo folder (a read). */
export async function photoCount(ctx: Cx, folder: string): Promise<number> {
  const drive = cfg(ctx).photos.drive;
  if (!ID.test(drive) || !ID.test(folder)) throw new Error("microsoft-365: bad photo folder id");
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.ListChildren", summary: "count vehicle photos",
    input: { params: { "drive-id": drive, "driveItem-id": folder } } });
  return (r.data?.value ?? []).filter((f: any) => String(f?.file?.mimeType ?? "").startsWith("image/")).length;
}

/** Create an Outlook draft (a draft operation) and return the send act for approval. */
export async function mailDraft(ctx: Cx, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; act: Act }> {
  if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
  const box = cfg(ctx).mailbox;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${m.to}`, input: { params: { "user-id": box }, body: {
    subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${m.to}`,
    input: { params: { "user-id": box, "message-id": id } } } };
}

/** One row in the listing register (a draft operation: an internal workbook). */
export async function registerRow(ctx: Cx, values: (string | number)[]): Promise<void> {
  const reg = cfg(ctx).register;
  if (!reg) return;
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: "add to listing register",
    input: { params: table(reg), body: { values: [[day(ctx.now), ...values.map(cell)]] } } });
}
