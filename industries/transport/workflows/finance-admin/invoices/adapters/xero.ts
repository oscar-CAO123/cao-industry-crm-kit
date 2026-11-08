// Xero: the rate card (its item list), the customer, and the invoice. Every invoice is created as a DRAFT (internal, a cron
// may do that). Authorising it and emailing it, which is also how a reminder goes out, are live operations: the cron only
// queues them, and a person approves each one. Field names come from Xero's official accounting spec (Invoice, LineItem,
// Contact, Items).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Customer, type RateItem, type Settings, type Trip, EMAIL, GUID, day, addDays, guid, round2, xeroDate } from "../types.ts";

const P = "xero";
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });
type Status = Trip["status"];
const STATUS: Record<string, Status> = { DRAFT: "drafted", SUBMITTED: "drafted", AUTHORISED: "authorised", PAID: "paid", VOIDED: "voided", DELETED: "voided" };

/** The rate card: every item with a code and a sales unit price, keyed by lower-case code. */
export async function rateCard(ctx: Ctx<Settings>): Promise<Map<string, RateItem>> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getItems", summary: "read the rate card" });
  const out = new Map<string, RateItem>();
  for (const i of r.data?.Items ?? []) {
    const price = Number(i.SalesDetails?.UnitPrice);
    if (!i.Code || !Number.isFinite(price)) continue;
    out.set(String(i.Code).toLowerCase(), { code: String(i.Code), name: String(i.Name ?? i.Code).slice(0, 4000), price });
  }
  return out;
}

/** Finds the customer by email, or creates them as a contact. */
export async function contactId(ctx: Ctx<Settings>, c: Customer, ref: string): Promise<string> {
  const email = c.email && EMAIL.test(c.email) ? c.email : undefined;
  if (email) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: "find customer", input: { params: { searchTerm: email, summaryOnly: true } } });
    const hit = (r.data?.Contacts ?? []).find((x: any) => String(x.EmailAddress ?? "").toLowerCase() === email.toLowerCase());
    if (hit) return guid(hit.ContactID);
  }
  const name = (c.name || email || "Trip customer").slice(0, 255);
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create customer ${name}`,
    input: { params: idem(`contact:${ref}`), body: { Contacts: [{ Name: name, ...(email ? { EmailAddress: email } : {}) }] } } });
  return guid(r.data?.Contacts?.[0]?.ContactID);
}

/** Creates the invoice as a DRAFT. The idempotency key means a retried run never makes a second one. */
export async function draftInvoice(ctx: Ctx<Settings>, t: Trip, priced: { item: RateItem; qty: number }[], contact: string): Promise<string> {
  const body = { Invoices: [{
    Type: "ACCREC", Contact: { ContactID: contact }, Date: day(ctx.now), DueDate: day(addDays(ctx.now, ctx.settings.due_days)),
    Status: "DRAFT", Reference: t.reference.slice(0, 255), LineAmountTypes: "Exclusive",
    LineItems: priced.map((p) => ({ ItemCode: p.item.code, Description: p.item.name, Quantity: p.qty, UnitAmount: p.item.price,
      ...(ctx.settings.sales_account_code ? { AccountCode: ctx.settings.sales_account_code } : {}) })),
  }] };
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft invoice for ${t.reference}`, input: { params: idem(`invoice:${t.id}`), body } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}

/** Current status, amount due, due date and sent flag for these invoices (at most 50 a call). Reads only. */
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
  platform: P, op: "accounting.updateInvoice", key, summary: `authorise invoice ${id} in Xero`,
  input: { params: { InvoiceID: guid(id), ...idem(`authorise:${id}`) }, body: { Invoices: [{ InvoiceID: guid(id), Status: "AUTHORISED" }] } },
});

/** Queued: email the invoice to the customer. The same call sends a reminder for an invoice already sent. */
export const emailAct = (id: string, key: string, summary: string): Act => ({
  platform: P, op: "accounting.emailInvoice", key, summary,
  input: { params: { InvoiceID: guid(id), ...idem(key) }, body: {} },
});
