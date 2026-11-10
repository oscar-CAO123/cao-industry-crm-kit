// Xero: where the invoice lives. Every invoice is created as a DRAFT (internal, a cron may do that). Authorising it,
// emailing it, recording a payment against it and sending a reminder are all live operations: the cron only queues
// them, and a person approves each one. Field names come from Xero's official accounting spec (Invoice, LineItem,
// Payment, Contact).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Contact, type Line, type Settings, EMAIL, GUID, day, addDays, guid, round2, xeroDate, money } from "../types.ts";

const P = "xero";
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });
type Status = "drafted" | "authorised" | "paid" | "voided";
const STATUS: Record<string, Status> = { DRAFT: "drafted", SUBMITTED: "drafted", AUTHORISED: "authorised", PAID: "paid", VOIDED: "voided", DELETED: "voided" };

/** Finds the customer by email, or creates them as a contact (a draft-side record). */
export async function contactId(ctx: Ctx<Settings>, c: Contact, ref: string): Promise<string> {
  const email = c.email && EMAIL.test(c.email) ? c.email : undefined;
  if (email) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: "find contact", input: { params: { searchTerm: email, summaryOnly: true } } });
    const hit = (r.data?.Contacts ?? []).find((x: any) => String(x.EmailAddress ?? "").toLowerCase() === email.toLowerCase());
    if (hit) return guid(hit.ContactID);
  }
  const name = (c.name || email || "ServiceM8 customer").slice(0, 255);
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create contact ${name}`,
    input: { params: idem(`contact:${ref}`), body: { Contacts: [{ Name: name, ...(email ? { EmailAddress: email } : {}) }] } } });
  return guid(r.data?.Contacts?.[0]?.ContactID);
}

/** Creates the invoice as a DRAFT. The idempotency key means a retried run never makes a second one. */
export async function draftInvoice(ctx: Ctx<Settings>, job: string, lines: Line[], contact: string): Promise<string> {
  const body = { Invoices: [{
    Type: "ACCREC", Contact: { ContactID: contact }, Date: day(ctx.now), DueDate: day(addDays(ctx.now, ctx.settings.due_days)),
    Status: "DRAFT", Reference: job.slice(0, 255), LineAmountTypes: "Exclusive",
    LineItems: lines.map((l) => ({ Description: l.name.slice(0, 4000), Quantity: l.qty, UnitAmount: l.unitPrice,
      ...(ctx.settings.sales_account_code ? { AccountCode: ctx.settings.sales_account_code } : {}) })),
  }] };
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft invoice for job ${job}`, input: { params: idem(`invoice:${job}`), body } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}

/** Current status, amount due, due date and sent flag for these invoices (at most 50 a call). */
export async function refresh(ctx: Ctx<Settings>, ids: string[]) {
  const out = new Map<string, { status: Status; amount_due: number; due?: string; sent: boolean }>();
  const clean = [...new Set(ids.filter((i) => GUID.test(i)))].slice(0, 50);
  if (!clean.length) return out;
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `read ${clean.length} invoices`,
    input: { params: { IDs: clean.join(","), pageSize: 50 } } });
  for (const i of r.data?.Invoices ?? []) {
    const id = String(i.InvoiceID ?? "");
    if (!GUID.test(id)) continue;
    out.set(id, { status: STATUS[String(i.Status)] ?? "drafted", amount_due: round2(Number(i.AmountDue ?? 0)), due: xeroDate(i.DueDate), sent: i.SentToContact === true });
  }
  return out;
}

/** Queued: move a DRAFT invoice to AUTHORISED. Once authorised, Xero gives it its number. */
export const authoriseAct = (id: string, key: string): Act => ({
  platform: P, op: "accounting.updateOrCreateInvoices", key, summary: `authorise invoice ${id} in Xero`,
  input: { params: idem(`authorise:${id}`), body: { Invoices: [{ InvoiceID: guid(id), Status: "AUTHORISED" }] } },
});

/** Queued: email the invoice to the customer. Also the reminder: Xero's API sends the invoice copy. */
export const emailAct = (id: string, key: string, summary: string): Act => ({
  platform: P, op: "accounting.emailInvoice", key, summary,
  input: { params: { InvoiceID: guid(id), ...idem(key) }, body: {} },
});

/** Queued: record a payment the trade took in ServiceM8 against the Xero invoice. */
export const paymentAct = (ctx: Ctx<Settings>, invoice: string, amount: number, paymentUuid: string): Act => ({
  platform: P, op: "accounting.createPayment", key: `payment:${paymentUuid}`, summary: `record ${money(amount)} against invoice ${invoice} in Xero`,
  input: { params: idem(`payment:${paymentUuid}`), body: { Invoice: { InvoiceID: guid(invoice) }, Account: { Code: ctx.settings.bank_account_code }, Date: day(ctx.now),
    Amount: amount, Reference: `ServiceM8 ${paymentUuid}`.slice(0, 255) } },
});
