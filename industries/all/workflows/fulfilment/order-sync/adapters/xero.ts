// Xero: the customer invoice and the supplier bill. Drafts only: every invoice is created as DRAFT and nothing here
// authorises, emails or pays one. Field names follow the Xero accounting API the kit maps (accounting.*).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Order, type Settings, guid, text, day } from "../types.ts";

const P = "xero";
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });

/** The Xero contact for a Cin7 customer: found by email, or created. */
export async function contactFor(ctx: Ctx<Settings>, o: Order): Promise<string> {
  if (o.email) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: `find contact for sales order ${o.id}`,
      input: { params: { searchTerm: o.email, summaryOnly: true } } });
    const hit = (r.data?.Contacts ?? []).find((c: any) => String(c.EmailAddress ?? "").toLowerCase() === o.email!.toLowerCase());
    if (hit) return guid(hit.ContactID);
  }
  const name = text(o.customer || o.email || `Cin7 order ${o.id}`, 255);
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create contact for sales order ${o.id}`,
    input: { params: idem(`contact-so-${o.id}`), body: { Contacts: [{ Name: name, ...(o.email ? { EmailAddress: o.email } : {}) }] } } });
  return guid(r.data?.Contacts?.[0]?.ContactID);
}

/** A DRAFT customer invoice for the shipped quantities on one Cin7 sales order. */
export async function draftInvoice(ctx: Ctx<Settings>, o: Order, contact: string): Promise<string> {
  const due = new Date(ctx.now.getTime() + (ctx.settings.invoice?.due_days ?? 30) * 864e5);
  const lines = o.lines
    .map((l) => ({ Description: text(`${l.code} ${l.name}`, 4000), Quantity: l.qtyShipped || l.qty, UnitAmount: l.unitPrice }))
    .filter((l) => l.Quantity > 0);
  if (!lines.length) throw new Error(`sales order ${o.id} has no shipped lines`);
  const body = { Invoices: [{ Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: contact }, Date: day(ctx.now), DueDate: day(due),
    Reference: `SO-${o.id}`, LineItems: lines }] };
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft invoice for sales order ${o.id}`,
    input: { params: idem(`invoice-so-${o.id}`), body } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}

/** Supplier bills (ACCPAY) in Xero. The caller keeps the ones that are authorised or paid. */
export async function supplierBills(ctx: Ctx<Settings>): Promise<any[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: "supplier bills",
    input: { params: { where: 'Type=="ACCPAY"', pageSize: 100 } } });
  return r.data?.Invoices ?? [];
}
