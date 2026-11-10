// Xero: the commercial invoice for an export shipment. Drafting creates a DRAFT sales invoice. Authorising and
// emailing it reach the buyer, so they are only ever queued for a person to approve.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Shipment, type Line, EMAIL, guid, round2, shipTotal } from "../types.ts";

const P = "xero";
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });
const day = (d: Date) => d.toISOString().slice(0, 10);

/** The existing Xero contact with exactly this email, or undefined. Never creates one. */
async function findContactId(ctx: Ctx<Settings>, email: string): Promise<string | undefined> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: "find buyer", input: { params: { searchTerm: email, summaryOnly: true } } });
  const hit = (r.data?.Contacts ?? []).find((c: any) => String(c.EmailAddress ?? "").toLowerCase() === email.toLowerCase());
  return hit ? guid(hit.ContactID) : undefined;
}

/** Finds the buyer by email, or creates them. Xero ignores a repeated create with the same key. */
async function contactId(ctx: Ctx<Settings>, s: Shipment): Promise<string> {
  const email = s.buyer.email && EMAIL.test(s.buyer.email) ? s.buyer.email : undefined;
  if (email) {
    const hit = await findContactId(ctx, email);
    if (hit) return hit;
  }
  const name = (s.buyer.name || email || s.title).slice(0, 255);
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create buyer ${name}`,
    input: { params: idem(`contact:${s.id}`), body: { Contacts: [{ Name: name, ...(email ? { EmailAddress: email } : {}) }] } } });
  return guid(r.data?.Contacts?.[0]?.ContactID);
}

/** Draft: one DRAFT sales invoice in Xero with the shipment's lines. Nothing is authorised or sent. */
export async function draftInvoice(ctx: Ctx<Settings>, s: Shipment): Promise<string> {
  const contact = await contactId(ctx, s);
  const due = new Date(ctx.now.getTime() + (ctx.settings.invoice_due_days ?? 30) * 864e5);
  const body = { Invoices: [{ Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: contact }, Date: day(ctx.now), DueDate: day(due),
    Reference: s.id.slice(0, 255),
    LineItems: s.lines.map((l: Line) => ({ Description: l.description, Quantity: l.qty, UnitAmount: l.unitPrice })) }] };
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft invoice for ${s.title}`,
    input: { params: idem(`invoice:${s.id}`), body } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}

/** Cross-check: reads the Xero invoice and compares it with the shipment record. Returns the problem, or null when they match. */
export async function compareInvoice(ctx: Ctx<Settings>, s: Shipment): Promise<string | null> {
  if (!s.invoice_id) return "no invoice in Xero yet";
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoice", summary: `read invoice for ${s.title}`,
    input: { params: { InvoiceID: guid(s.invoice_id) } } });
  const inv = r.data?.Invoices?.[0];
  if (!inv) return "invoice not found in Xero";
  if (!["DRAFT", "AUTHORISED"].includes(String(inv.Status))) return `invoice is ${String(inv.Status).slice(0, 20)} in Xero`;
  const items: any[] = inv.LineItems ?? [];
  if (items.length !== s.lines.length) return `Xero has ${items.length} lines, the shipment has ${s.lines.length}`;
  for (let i = 0; i < items.length; i++) {
    const a = s.lines[i], b = items[i];
    if (Number(b.Quantity) !== a.qty || round2(Number(b.UnitAmount)) !== round2(a.unitPrice)) return `line ${i + 1} differs from the shipment`;
  }
  if (round2(Number(inv.Total)) !== shipTotal(s.lines)) return "invoice total differs from the shipment";
  // Authorise and email go to the invoice's contact, not to the buyer email on the record: they must be the same contact.
  if (s.buyer.email && EMAIL.test(s.buyer.email)) {
    const buyer = await findContactId(ctx, s.buyer.email);
    if (!buyer || String(inv.Contact?.ContactID ?? "").toLowerCase() !== buyer.toLowerCase()) return "the Xero invoice is not addressed to the buyer email on the record";
  }
  return null;
}

/** Live: authorise the invoice, then email it to the buyer. Only ever queued; a person approves it. */
export function sendActs(s: Shipment) {
  const InvoiceID = guid(s.invoice_id);
  return [
    { platform: P, op: "accounting.updateInvoice", key: `send:${s.id}`, summary: `authorise invoice for ${s.title} in Xero`,
      input: { params: { InvoiceID }, body: { Invoices: [{ InvoiceID, Status: "AUTHORISED" }] } } },
    { platform: P, op: "accounting.emailInvoice", summary: `email invoice for ${s.title} to ${s.buyer.email ?? "the buyer"}`,
      input: { params: { InvoiceID, ...idem(`email:${s.id}`) }, body: {} } },
  ];
}
