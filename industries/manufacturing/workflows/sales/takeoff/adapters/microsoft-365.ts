// Microsoft 365 for the takeoff workflow. Requests come from an Outlook folder. The estimator's measured quantities and
// the supplier rate card are Excel tables. The priced quote is an Outlook draft to the requester, with a register row.
// Sending the draft is always an approval: this adapter only queues it.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Enquiry, type Line, type Quote, type RateItem, type Measured, type Table,
         EMAIL, MAX_QTY, keyOf, day, cell, sendSummary, total, jobRef, quoteHtml } from "../types.ts";

const P = "microsoft-365";
const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
const cfg = (ctx: Ctx<Settings>) => {
  const m = ctx.settings.microsoft_365;
  if (!m?.mailbox || !EMAIL.test(m.mailbox)) throw new Error("microsoft_365.mailbox (the business's own) is not set");
  return m;
};
const table = (t: Table) => {
  for (const v of [t.drive, t.item, t.table]) if (!ID.test(v)) throw new Error("microsoft-365: bad workbook id");
  return { "drive-id": t.drive, "driveItem-id": t.item, "workbookTable-id": t.table };
};

export const microsoft365: Adapter & {
  mailDraft(ctx: Ctx<Settings>, m: { to: string; subject: string; html: string }): Promise<{ messageId: string; act: Act }>;
} = {
  id: P,
  /** Create an Outlook draft (a draft operation) and return the send act, for the caller to queue for approval. */
  async mailDraft(ctx, m) {
    if (!EMAIL.test(m.to)) throw new Error("microsoft-365: bad recipient");
    const box = cfg(ctx).mailbox;
    const r = await ctx.draft<any>({ platform: P, op: "users.CreateMessages", summary: `draft email to ${m.to}`, input: { params: { "user-id": box }, body: {
      subject: m.subject.slice(0, 250), body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] } } });
    const id = String(r.data?.id ?? "");
    if (!ID.test(id)) throw new Error("microsoft-365: draft not created");
    return { messageId: id, act: { platform: P, op: "users.user.messages.message.send", summary: `send email to ${m.to}`, input: { params: { "user-id": box, "message-id": id } } } };
  },
  async enquiries(ctx) {
    const m = cfg(ctx);
    const r = await ctx.draft<any>({ platform: P, op: "users.mailFolders.ListMessages", summary: "read takeoff requests", input: { params: {
      "user-id": m.mailbox, "mailFolder-id": m.folder ?? "inbox", $search: `"${(m.search ?? "takeoff").replace(/["\\]/g, "")}"`, $top: 25,
      $select: "id,subject,from,receivedDateTime,bodyPreview" } } });
    return (r.data?.value ?? []).filter((x: any) => ID.test(String(x.id ?? ""))).map((x: any) => {
      const title = String(x.subject ?? "Takeoff request").slice(0, 120);
      const job = jobRef(title);
      return {
        id: keyOf(`m365:${x.id}`), source: P as const, title, text: String(x.bodyPreview ?? "").slice(0, 4000),
        contact: { name: String(x.from?.emailAddress?.name ?? "").slice(0, 120) || undefined, email: EMAIL.test(x.from?.emailAddress?.address ?? "") ? x.from.emailAddress.address : undefined },
        received: String(x.receivedDateTime ?? ctx.now.toISOString()), ref: { message_id: x.id, ...(job ? { job } : {}) } };
    });
  },
  async takeoff(ctx) {
    const t = cfg(ctx).takeoff;
    if (!t) throw new Error("microsoft_365.takeoff is not set");
    const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read takeoff quantities", input: { params: table(t) } });
    return (r.data?.value ?? []).map((row: any) => row.values?.[0] ?? []).filter((v: any[]) => v[0] && v[1] && Number.isFinite(Number(v[2])))
      .map((v: any[]): Measured => ({ job: jobRef(String(v[0])) ?? "", code: String(v[1]), qty: Number(v[2]), unit: v[3] ? String(v[3]) : undefined }))
      .filter((m: Measured) => m.job && m.qty > 0 && m.qty <= MAX_QTY);
  },
  async rateCard(ctx) {
    const t = cfg(ctx).rate_card;
    if (!t) throw new Error("microsoft_365.rate_card is not set");
    const r = await ctx.draft<any>({ platform: P, op: "drives.items.workbook.tables.ListRows", summary: "read rate card", input: { params: table(t) } });
    return (r.data?.value ?? []).map((row: any) => row.values?.[0] ?? []).filter((v: any[]) => v[0] && Number.isFinite(Number(v[3])))
      .map((v: any[]): RateItem => ({ code: String(v[0]), name: String(v[1] ?? v[0]), unit: v[2] ? String(v[2]) : undefined, price: Number(v[3]) }));
  },
  /** The priced takeoff as an Outlook draft to the requester, with a register row. The send waits for approval. */
  async draftQuote(ctx, e: Enquiry, lines: Line[]) {
    if (!e.contact.email) throw new Error("microsoft-365: the requester has no email address");
    const q: Quote = { key: keyOf(`quote:${e.id}`), platform: P, enquiry: e.id, job: e.ref.job ?? "", contact: e.contact, lines,
      total_ex_gst: total(lines), status: "draft", ref: {}, created: ctx.now.toISOString() };
    const reg = cfg(ctx).register;
    if (reg) await ctx.draft({ platform: P, op: "drives.items.workbook.tables.CreateRows", summary: "add to takeoff register",
      input: { params: table(reg), body: { values: [[day(ctx.now), cell(q.job), cell(q.key), cell(e.contact.name ?? ""), cell(e.contact.email), q.total_ex_gst, "Draft"]] } } });
    const d = await microsoft365.mailDraft(ctx, { to: e.contact.email, subject: `Your takeoff quote${q.job ? ` ${q.job}` : ""} from ${ctx.settings.business_name ?? "us"}`,
      html: quoteHtml(ctx.settings, q, `Hi ${e.contact.name ?? "there"}, here is the priced takeoff for ${e.title}.`) });
    q.ref.draft_message = d.messageId;
    await ctx.queue({ ...d.act, key: `send:${q.key}` }, sendSummary(`Email takeoff quote for ${e.title}`, e.contact.email, q));
    return q;
  },
};
