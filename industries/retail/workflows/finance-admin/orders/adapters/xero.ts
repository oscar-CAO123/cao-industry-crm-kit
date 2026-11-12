// Xero: where the order is entered, as a DRAFT invoice. A draft invoice reaches nobody outside the business, so it is a
// draft operation. Authorising it and emailing it to the customer are not in this workflow; the owner does that in Xero.
// Field names are from the Xero accounting spec (xero_accounting): Invoice.Type, Contact,
// Status, Reference, LineItems; LineItem.ItemCode, Description, Quantity, UnitAmount; Contact.ContactID, Name, EmailAddress.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Order, type Line, EMAIL, clean, day } from "../types.ts";

const P = "xero" as const;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
/** Xero ignores a repeated create with the same key, so a retried run never makes a second contact or invoice. */
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });

export interface Item { code: string; name: string; price: number; itemId: string }

/** The item list, which is the rate card the proposed lines are checked against. Reads only. */
async function rateCard(ctx: Ctx<Settings>): Promise<Item[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getItems", summary: "read the item list" });
  return (r.data?.Items ?? []).filter((i: any) => i.Code && Number.isFinite(Number(i.SalesDetails?.UnitPrice)))
    .map((i: any): Item => ({ code: String(i.Code), name: clean(i.Name ?? i.Code, 200), price: Number(i.SalesDetails.UnitPrice), itemId: String(i.ItemID ?? "") }));
}

async function contactId(ctx: Ctx<Settings>, o: Order): Promise<string> {
  const email = o.contact.email && EMAIL.test(o.contact.email) ? o.contact.email : undefined;
  if (email) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: "find customer", input: { params: { searchTerm: email, summaryOnly: true } } });
    const hit = (r.data?.Contacts ?? []).find((c: any) => String(c.EmailAddress ?? "").toLowerCase() === email);
    if (hit) return guid(hit.ContactID);
  }
  const name = clean(o.contact.name || email || o.title, 255);
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create customer ${name}`,
    input: { params: idem(`contact:${o.id}`), body: { Contacts: [{ Name: name, ...(email ? { EmailAddress: email } : {}) }] } } });
  return guid(r.data?.Contacts?.[0]?.ContactID);
}

/** The order as a DRAFT sales invoice in Xero. Internal: nothing leaves the business. */
async function draftInvoice(ctx: Ctx<Settings>, o: Order, lines: Line[]): Promise<string> {
  const contact = await contactId(ctx, o);
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft invoice for order ${o.id}`,
    input: { params: idem(`invoice:${o.id}`), body: { Invoices: [{ Type: "ACCREC", Contact: { ContactID: contact }, Date: day(ctx.now), Status: "DRAFT",
      Reference: clean(o.title || o.id, 255), LineItems: lines.map((l) => ({ ItemCode: l.code, Description: l.name, Quantity: l.qty, UnitAmount: l.unitPrice })) }] } } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}

export const xero = { rateCard, draftInvoice };
