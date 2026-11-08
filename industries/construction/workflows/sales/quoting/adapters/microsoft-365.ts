// Microsoft 365: what most owners actually quote with. Quote requests from an Outlook folder, prices from an Excel
// table (Code | Name | Unit | Price), the quote as an Outlook draft with the priced table, and a register row in an
// Excel table (Date | Quote | Client | Email | Total ex GST | Status). Sending a draft is always an approval.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Enquiry, type Line, type Quote, type RateItem, EMAIL, total, quoteHtml, keyOf, day, esc, cell, sendSummary } from "../types.ts";

const P = "microsoft-365";
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox (the client's own) is not set");
  return m;
};
const table = (t: { drive: string; item: string; table: string }) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

export const microsoft365: Adapter & {
  mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string; attachment?: { name: string; bytes: string } }): Promise<{ messageId: string; act: Act }>;
} = {
  id: P,
  /** Create an Outlook draft (a draft operation) and return the send act, for the caller to queue for approval. */
  async mailDraft(ctx, m) {
    if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
    const box = cfg(ctx).mailbox;
    const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${m.to}`, input: { params: { "user-id": box }, body: {
      subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }],
      ...(m.attachment ? { attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: m.attachment.name, contentType: "application/pdf", contentBytes: m.attachment.bytes }] } : {}) } } });
    const id = String(r.data?.id ?? "");
    if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
    return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${m.to}`, input: { params: { "user-id": box, "message-id": id } } } };
  },
  async enquiries(ctx) {
    const m = cfg(ctx);
    const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read quote requests", input: { params: {
      "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $search: `"${(m.search ?? "quote").replace(/["\\]/g, "")}"`, $top: 25,
      $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
    return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => ({
      id: keyOf(`m365:${x.id}`), source: P as const, title: String(x.subject ?? "Quote request").slice(0, 120), text: String(x.bodyPreview ?? "").slice(0, 4000),
      contact: { name: String(x.from?.emailAddress?.name ?? "").slice(0, 120) || undefined, email: EMAIL.test(x.from?.emailAddress?.address ?? "") ? x.from.emailAddress.address : undefined },
      received: String(x.receivedDateTime ?? ctx.now.toISOString()), ref: { message_id: x.id } }));
  },
  async rateCard(ctx) {
    const t = cfg(ctx).rate_card;
    if (!t) throw new Error("microsoft_365.rate_card is not set");
    const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read rate card", input: { params: table(t) } });
    return (r.data?.value ?? []).map((row: any) => row.values?.[0] ?? []).filter((v: any[]) => v[0] && Number.isFinite(Number(v[3])))
      .map((v: any[]): RateItem => ({ code: String(v[0]), name: String(v[1] ?? v[0]), unit: v[2] ? String(v[2]) : undefined, price: Number(v[3]) }));
  },
  /** For businesses that quote from Excel and Outlook only: the quote is an Outlook draft with the priced table. */
  async draftQuote(ctx, e: Enquiry, lines: Line[]) {
    const q: Quote = { key: keyOf(`m365:${e.id}`), platform: P, enquiry: e.id, contact: e.contact, lines, total_ex_gst: total(lines), status: "draft", ref: {}, created: ctx.now.toISOString() };
    const reg = cfg(ctx).register;
    if (reg) await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: "add to quote register",
      input: { params: table(reg), body: { values: [[day(ctx.now), cell(q.key), cell(e.contact.name ?? ""), cell(e.contact.email ?? ""), q.total_ex_gst, "Draft"]] } } });
    if (e.contact.email) {
      const d = await microsoft365.mailDraft(ctx, { to: e.contact.email, subject: `Your quote from ${ctx.settings.business_name ?? "us"}`, html: quoteHtml(ctx.settings, q, `Hi ${e.contact.name ?? "there"}, here is your quote for ${e.title}.`) });
      q.ref.draft_message = d.messageId;
      await ctx.queue({ ...d.act, key: `send:${q.key}` }, sendSummary(`Email quote for ${e.title}`, e.contact.email, q, (e as any).priced_by_proposal));
    }
    return q;
  },
  async followUp(ctx, q, n) {
    if (!q.contact.email) return "";
    const d = await microsoft365.mailDraft(ctx, { to: q.contact.email, subject: "Following up on your quote", html: `<p>Hi ${esc(q.contact.name ?? "there")}, just checking you received our quote. Happy to answer any questions.</p>` });
    return ctx.queue({ ...d.act, key: `follow${n}:${q.key}` }, `follow-up ${n} email to ${q.contact.email}`);
  },
};
