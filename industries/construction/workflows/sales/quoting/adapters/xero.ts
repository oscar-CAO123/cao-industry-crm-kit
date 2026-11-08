// Xero: the quote that lives in accounting. A Quote moves DRAFT, SENT, ACCEPTED or DECLINED, then INVOICED.
// Xero's API cannot email a quote, so sending goes through the business's mailbox (settings.messages) with the
// Xero PDF attached, and marking it SENT in Xero is part of the same approval.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Enquiry, type Line, type Quote, type RateItem, EMAIL, total, quoteHtml, keyOf, day, esc, sendSummary } from "../types.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
/** Xero ignores a repeated create with the same key, so a retried run never makes a second quote, contact or invoice. */
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });
import { microsoft365 } from "./microsoft-365.ts";

const P = "xero";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };

async function contactId(ctx: Ctx<Settings>, e: Enquiry): Promise<string> {
  const email = e.contact.email && EMAIL.test(e.contact.email) ? e.contact.email : undefined;
  if (email) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: "find contact", input: { params: { searchTerm: email, summaryOnly: true } } });
    const hit = (r.data?.Contacts ?? []).find((c: any) => String(c.EmailAddress ?? "").toLowerCase() === email.toLowerCase());
    if (hit) return guid(hit.ContactID);
  }
  const name = (e.contact.name || email || e.title).slice(0, 255);
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create contact ${name}`,
    input: { params: idem(`contact:${e.id}`), body: { Contacts: [{ Name: name, ...(email ? { EmailAddress: email } : {}) }] } } });
  return guid(r.data?.Contacts?.[0]?.ContactID);
}

export const xero: Adapter = {
  id: P,
  async rateCard(ctx) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getItems", summary: "read items" });
    return (r.data?.Items ?? []).filter((i: any) => i.Code && Number.isFinite(Number(i.SalesDetails?.UnitPrice)))
      .map((i: any): RateItem => ({ code: String(i.Code), name: String(i.Name ?? i.Code), price: Number(i.SalesDetails.UnitPrice), ref: { item_id: String(i.ItemID ?? "") } }));
  },
  async draftQuote(ctx, e: Enquiry, lines: Line[]) {
    const contact = await contactId(ctx, e);
    const valid = new Date(ctx.now.getTime() + (ctx.settings.quote_valid_days ?? 30) * 864e5);
    const body = { Quotes: [{ Contact: { ContactID: contact }, Date: day(ctx.now), ExpiryDate: day(valid), Status: "DRAFT", Reference: e.id.slice(0, 255), Title: e.title.slice(0, 100),
      LineItems: lines.map((l) => ({ ...(ctx.settings.rate_card === "xero" ? { ItemCode: l.code } : {}), Description: l.name, Quantity: l.qty, UnitAmount: l.unitPrice })) }] };
    const r = await ctx.draft<any>({ platform: P, op: "accounting.createQuotes", summary: `draft quote for ${e.title}`, input: { params: idem(`quote:${e.id}`), body } });
    const id = guid(r.data?.Quotes?.[0]?.QuoteID);
    const q: Quote = { key: keyOf(`xero:${id}`), platform: P, enquiry: e.id, contact: e.contact, lines, total_ex_gst: total(lines), status: "draft",
                       ref: { quote_id: id, contact_id: contact }, created: ctx.now.toISOString() };
    const mark = { platform: P, op: "accounting.updateQuote", summary: `mark quote ${id} SENT in Xero`,
      input: { params: { QuoteID: id }, body: { Quotes: [{ QuoteID: id, Contact: { ContactID: contact }, Date: day(ctx.now), Status: "SENT" }] } } };
    if (e.contact.email && ctx.settings.messages === "microsoft-365") {
      const pdf = await ctx.draft<ArrayBuffer>({ platform: P, op: "accounting.getQuoteAsPdf", summary: "quote PDF", input: { params: { QuoteID: id }, binary: true } });
      const send = await microsoft365.mailDraft!(ctx, { to: e.contact.email, subject: `Your quote from ${ctx.settings.business_name ?? "us"}`,
        html: quoteHtml(ctx.settings, q, `Hi ${e.contact.name ?? "there"}, please find your quote attached.`),
        attachment: { name: `quote-${id.slice(0, 8)}.pdf`, bytes: Buffer.from(pdf.data).toString("base64") } });
      q.ref.draft_message = send.messageId;
      await ctx.queue([{ ...send.act, key: `send:${q.key}` }, mark], sendSummary(`Email quote for ${e.title} and mark it SENT in Xero`, e.contact.email, q, (e as any).priced_by_proposal));
    } else await ctx.queue({ ...mark, key: `send:${q.key}` }, sendSummary(`Mark quote for ${e.title} SENT in Xero (send it from Xero)`, e.contact.name ?? "the client", q, (e as any).priced_by_proposal));
    return q;
  },
  async refresh(ctx, quotes) {
    for (const q of quotes) {
      const r = await ctx.draft<any>({ platform: P, op: "accounting.getQuote", summary: "quote status", input: { params: { QuoteID: guid(q.ref.quote_id) } } });
      const st = r.data?.Quotes?.[0]?.Status;
      if (st === "ACCEPTED" && q.status !== "accepted") { q.status = "accepted"; q.accepted_at = ctx.now.toISOString(); }
      else if (st === "DECLINED") q.status = "declined";
      else if (st === "INVOICED") q.status = "invoiced";
    }
    return quotes;
  },
  async followUp(ctx, q, n) {
    if (!q.contact.email || ctx.settings.messages !== "microsoft-365") { ctx.log(`no mailbox for follow-up on ${q.key}`); return ""; }
    const d = await microsoft365.mailDraft!(ctx, { to: q.contact.email, subject: "Following up on your quote",
      html: `<p>Hi ${esc(q.contact.name ?? "there")}, just checking you received our quote. Happy to answer any questions.</p>` });
    return ctx.queue({ ...d.act, key: `follow${n}:${q.key}` }, `follow-up ${n} email to ${q.contact.email}`);
  },
};

/** On acceptance: a DRAFT invoice in Xero (deposit or full), never sent by the cron. */
export async function draftInvoice(ctx: Ctx<Settings>, q: Quote): Promise<string> {
  const pct = ctx.settings.handover?.deposit_percent ?? 0;
  const lines = pct > 0 && pct < 100
    ? [{ Description: `Deposit ${pct}% for quote ${q.key}`, Quantity: 1, UnitAmount: Math.round(q.total_ex_gst * pct) / 100 }]
    : q.lines.map((l) => ({ ...(ctx.settings.rate_card === "xero" ? { ItemCode: l.code } : {}), Description: l.name, Quantity: l.qty, UnitAmount: l.unitPrice }));
  const contact = q.ref.contact_id && GUID.test(q.ref.contact_id) ? q.ref.contact_id : await contactId(ctx, { id: q.enquiry, source: P, title: q.key, contact: q.contact, received: q.created, status: "drafted" });
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft invoice for ${q.key}`,
    input: { params: idem(`invoice:${q.key}`), body: { Invoices: [{ Type: "ACCREC", Contact: { ContactID: contact }, Status: "DRAFT", Reference: q.key.slice(0, 255), LineItems: lines }] } } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}
