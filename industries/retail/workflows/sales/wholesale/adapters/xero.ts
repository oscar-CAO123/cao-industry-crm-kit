// Xero: the stockist's contact, a DRAFT invoice for each order, and the approval that authorises and emails it.
// Xero ignores a repeated create with the same Idempotency-Key, so a retried run never makes a second contact or invoice.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey, type Act } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Account, type Order, type Line, EMAIL, GUID, DAY, day } from "../types.ts";

const P = "xero";
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });
const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };

/** Xero returns dates as "2026-11-20" or as "/Date(1700000000000+0000)/". Both become epoch milliseconds. */
export function parseXeroDate(v: unknown): number | undefined {
  const s = String(v ?? "");
  const m = /\/Date\((-?\d+)/.exec(s);
  const t = m ? Number(m[1]) : Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** The stockist's Xero contact: found by email when one matches, otherwise created as a contact record. */
export async function contactId(ctx: Ctx<Settings>, a: Account): Promise<string> {
  const email = a.email && EMAIL.test(a.email) ? a.email : undefined;
  if (email) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: "find contact", input: { params: { searchTerm: email, summaryOnly: true } } });
    const hit = (r.data?.Contacts ?? []).find((c: any) => String(c.EmailAddress ?? "").toLowerCase() === email.toLowerCase());
    if (hit) return guid(hit.ContactID);
  }
  const name = a.name.slice(0, 255);
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create contact ${name}`,
    input: { params: idem(`contact:${a.id}`), body: { Contacts: [{ Name: name, ...(email ? { EmailAddress: email } : {}) }] } } });
  return guid(r.data?.Contacts?.[0]?.ContactID);
}

/** The invoice body. Payment terms are the DueDate, set from the order date plus the account's terms. */
function invoiceBody(ctx: Ctx<Settings>, o: Order, contact: string, status: "DRAFT" | "AUTHORISED", due: string, invoiceId?: string) {
  const s = ctx.settings.invoice ?? {};
  return { Invoices: [{ ...(invoiceId ? { InvoiceID: invoiceId } : {}), Type: "ACCREC", Contact: { ContactID: contact }, Date: day(ctx.now), DueDate: due, Status: status,
    Reference: String(o.po ?? o.id).slice(0, 255), LineAmountTypes: s.line_amount_types ?? "Exclusive",
    LineItems: o.lines.map((l: Line) => ({ Description: String(l.description).slice(0, 4000), Quantity: l.qty, UnitAmount: l.unitPrice })) }] };
}

/** The due date for a new invoice, from the workflow's payment terms. */
export function dueFor(ctx: Ctx<Settings>): string {
  const terms = Number(ctx.settings.invoice?.payment_terms_days ?? 30);
  return day(new Date(ctx.now.getTime() + terms * DAY));
}

/** Create the invoice as a DRAFT in Xero. Nothing leaves the business at this step. */
export async function draftInvoice(ctx: Ctx<Settings>, o: Order, contact: string, due: string): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft invoice for ${o.id}`,
    input: { params: idem(`invoice:${o.id}`), body: invoiceBody(ctx, o, contact, "DRAFT", due) } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}

/** The two live acts that send an invoice: authorise it, then email it. They run together in one approval. */
export function sendActs(ctx: Ctx<Settings>, o: Order, a: Account, contact: string): Act[] {
  const id = guid(o.invoice_id);
  return [
    { platform: P, op: "accounting.updateOrCreateInvoices", summary: `authorise invoice for ${o.id}`, key: `send:${o.id}`,
      input: { params: idem(`authorise:${o.id}`), body: invoiceBody(ctx, o, contact, "AUTHORISED", o.due!, id) } },
    { platform: P, op: "accounting.emailInvoice", summary: `email invoice for ${o.id} to ${a.email}`,
      input: { params: { InvoiceID: id, ...idem(`email:${o.id}:1`) } } },
  ];
}

/** One chase: email the authorised invoice again. Live, so it is only ever queued. */
export function chaseAct(o: Order, step: number): Act {
  return { platform: P, op: "accounting.emailInvoice", summary: `chase invoice for ${o.id} (step ${step})`, key: `chase:${o.id}:${step}`,
    input: { params: { InvoiceID: guid(o.invoice_id), ...idem(`chase:${o.id}:${step}`) } } };
}

/** Authorised invoices still open in Xero. Reads up to 10 pages of 100. */
export async function openInvoices(ctx: Ctx<Settings>): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `open invoices, page ${page}`,
      input: { params: { Statuses: "AUTHORISED", page, pageSize: 100 } } });
    const rows: any[] = r.data?.Invoices ?? [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}
