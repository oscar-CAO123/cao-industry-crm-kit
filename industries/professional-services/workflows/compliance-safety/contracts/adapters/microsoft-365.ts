// Microsoft 365: contract emails in from an Outlook folder, the review note and reminders as Outlook drafts, and a
// register row in an Excel table. Every email is queued for a person to approve; nothing here sends.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Contract, type Settings, EMAIL, esc, cell, keyOf, ownerEmail } from "../types.ts";

const P = "microsoft-365";
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  return m;
};
const folder = (ctx: Ctx<Settings>) => cfg(ctx).folder ?? "inbox";

/** Contract emails in the folder: subject, sender, date and attachment names. Never the body text. Read only. */
export async function newContracts(ctx: Ctx<Settings>): Promise<Omit<Contract, "status">[]> {
  const m = cfg(ctx);
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read contract emails", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": folder(ctx), $top: 25,
    $search: `"${(m.search ?? "contract").replace(/["\\]/g, "")}"`,
    $select: "id,subject,from,receivedDateTime,hasAttachments" } } });
  const out: Omit<Contract, "status">[] = [];
  for (const x of r.data?.value ?? []) {
    const id = String(x.id ?? "");
    if (!ID.test(id)) continue;
    let attachments: Contract["attachments"] = [];
    if (x.hasAttachments) {
      const a = await ctx.draft<any>({ platform: P, op: "users.mailFolders.messages.ListAttachments", summary: "list attachment names", input: { params: {
        "user-id": m.mailbox, "mailFolder-id": folder(ctx), "message-id": id } } });
      attachments = (a.data?.value ?? []).slice(0, 20).map((f: any) => ({ name: String(f.name ?? "file").slice(0, 160), size: Number(f.size) || 0 }));
    }
    const addr = String(x.from?.emailAddress?.address ?? "");
    out.push({ id: keyOf(`m365:${id}`), title: String(x.subject ?? "Contract").slice(0, 160),
      from: { name: String(x.from?.emailAddress?.name ?? "").slice(0, 120) || undefined, email: EMAIL.test(addr) ? addr : undefined },
      received: String(x.receivedDateTime ?? ""), attachments, ref: { message_id: id } });
  }
  return out;
}

/** Outlook draft to the owner with the contract's details. Returns the send act for approval. */
export async function reviewNote(ctx: Ctx<Settings>, c: Contract): Promise<{ messageId: string; act: Act }> {
  const m = cfg(ctx), to = ownerEmail(ctx.settings);
  const files = c.attachments.map((a) => `${esc(a.name)} (${Math.max(1, Math.round(a.size / 1024))} KB)`).join(", ") || "none";
  const html = `<p>New contract to read: ${esc(c.title)}</p>`
    + `<p>From: ${esc(c.from.name ?? "")} ${esc(c.from.email ?? "")}<br>Received: ${esc(c.received)}<br>Attachments: ${files}</p>`
    + `<p>Read it by hand before anything is signed. Flag the liability, indemnity, termination, payment, IP, privacy, insurance and penalty clauses.</p>`;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft review note for ${c.title}`, input: { params: { "user-id": m.mailbox }, body: {
    subject: `Review: ${c.title}`.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: review note draft not created");
  return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", key: `review:${c.id}`,
    summary: `send review note to ${to} for ${c.title}`, input: { params: { "user-id": m.mailbox, "message-id": id } } } };
}

/** A row in the client's contract register (an internal log, so it is a draft operation). */
export async function registerRow(ctx: Ctx<Settings>, c: Contract): Promise<void> {
  const reg = cfg(ctx).register;
  if (!reg) return;
  for (const v of [reg.drive, reg.item, reg.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad register id");
  await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: "add contract to register", input: {
    params: { "drive-id": reg.drive, "driveItem-id": reg.item, "workbookTable-id": reg.table },
    body: { values: [[c.received.slice(0, 10), cell(c.id), cell(c.title), cell(c.from.name ?? ""), cell(c.from.email ?? ""), c.attachments.length, "In review"]] } } });
}

/** Outlook draft reminder to an unsigned signer. Returns the send act for approval. */
export async function reminderDraft(ctx: Ctx<Settings>, s: { name: string; email: string }, subject: string, key: string): Promise<Act> {
  const m = cfg(ctx);
  if (!EMAIL.test(s.email)) throw new Error("microsoft-365: bad recipient");
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft reminder to ${s.email}`, input: { params: { "user-id": m.mailbox }, body: {
    subject: `Reminder: ${subject}`.slice(0, 250),
    body: { contentType: "HTML", content: `<p>Hi ${esc(s.name || "there")},</p><p>Just checking you have had a chance to sign ${esc(subject)}. Happy to answer any questions.</p>` },
    toRecipients: [{ emailAddress: { address: s.email } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: reminder draft not created");
  return { platform: P, op: "users.user.messages.message.send", key, summary: `send reminder to ${s.email} for ${subject}`,
    input: { params: { "user-id": m.mailbox, "message-id": id } } };
}
