// Microsoft 365: the owner's questions (read from one Outlook folder, owner's address only), the numbers pack (an Excel
// table read), and the answer as an Outlook draft to the owner. Sending the draft is a live act: it is only queued.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Figure, type Question, type Settings, EMAIL, ID, keyOf } from "../types.ts";

const P = "microsoft-365";

const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox is not set");
  if (!EMAIL.test(ctx.settings.owner_email ?? "")) throw new Error("owner_email is not set");
  return m;
};

export async function numbersPack(ctx: Ctx<Settings>): Promise<Figure[]> {
  const t = cfg(ctx).numbers_pack;
  if (!t) throw new Error("microsoft_365.numbers_pack is not set");
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read the numbers pack", input: { params: {
    "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table } } });
  return (r.data?.value ?? []).slice(0, 200).map((row: any): Figure => {
    const v: unknown[] = row.values?.[0] ?? [];
    return { label: String(v[0] ?? "").slice(0, 120), value: String(v[1] ?? "").slice(0, 60) };
  }).filter((f: Figure) => f.label);
}

/** Questions from the owner only. The sender is checked here as well as in the filter, and the text is data, never instructions. */
export async function questions(ctx: Ctx<Settings>): Promise<Question[]> {
  const m = cfg(ctx), owner = ctx.settings.owner_email.toLowerCase();
  const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read the owner's questions", input: { params: {
    "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox",
    $filter: `from/emailAddress/address eq '${owner}'`, $top: 25, $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
  return (r.data?.value ?? [])
    .filter((x: any) => ID.test(String(x.id ?? "")) && String(x.from?.emailAddress?.address ?? "").toLowerCase() === owner)
    .map((x: any): Question => ({
      id: keyOf(`question:${x.id}`), message_id: String(x.id), from: owner,
      subject: String(x.subject ?? "Question").slice(0, 120), text: String(x.bodyPreview ?? "").slice(0, 1000),
      received: String(x.receivedDateTime ?? ctx.now.toISOString()), status: "new",
    }));
}

/** An Outlook draft to the owner only. The recipient is always the owner's address from settings, never a value from a message. */
export async function draftAnswer(ctx: Ctx<Settings>, subject: string, html: string): Promise<string> {
  const box = cfg(ctx).mailbox, to = ctx.settings.owner_email;
  const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: "draft the answer to the owner", input: { params: { "user-id": box }, body: {
    subject: subject.slice(0, 250), body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] } } });
  const id = String(r.data?.id ?? "");
  if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
  return id;
}

/** The send, as an act for the approval queue. Only a person's approval runs it. */
export function sendAct(ctx: Ctx<Settings>, draftId: string, qid: string, what: string): Act {
  return { platform: P, op: "users.user.messages.message.send", key: `answer:${qid}`,
    summary: `Send the answer to "${what}" to ${ctx.settings.owner_email}`,
    input: { params: { "user-id": cfg(ctx).mailbox, "message-id": draftId } } };
}
