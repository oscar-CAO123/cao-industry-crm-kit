// Xero: the bill that lives in accounting. A supplier bill is an ACCPAY invoice. It is entered as DRAFT (a draft
// operation), and only its authorisation (AUTHORISED, so it can be paid) is a live operation a person approves.
// The SDK sends JSON only, so the bill document is not attached here (see gaps in workflow.json).
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Bill, type Settings, GUID, guid, money, total } from "../types.ts";

const P = "xero";
/** Xero ignores a repeated create with the same key, so a retried run never makes a second contact or bill. */
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });
const PAGES = 5;

/** Xero dates come back as ISO or as /Date(ms)/. Returns YYYY-MM-DD. */
export function xeroDay(v: unknown): string {
  const s = String(v ?? "");
  const m = /\/Date\((-?\d+)/.exec(s);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : s.slice(0, 10);
}

/** The account codes in the chart of accounts. Read once per run. */
export async function chartCodes(ctx: Ctx<Settings>): Promise<Set<string>> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getAccounts", summary: "read chart of accounts" });
  return new Set((r.data?.Accounts ?? []).map((a: any) => String(a.Code ?? "")).filter(Boolean));
}

/** The supplier's contact id: the one Xero holds under that name, or a new supplier contact. Throws if the name is a customer. */
export async function supplierId(ctx: Ctx<Settings>, b: Bill, key: string): Promise<string> {
  const name = b.supplier.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 255);
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: `find supplier ${name}`,
    input: { params: { searchTerm: name, summaryOnly: true } } });
  const hit = (r.data?.Contacts ?? []).find((c: any) => String(c.Name ?? "").toLowerCase() === name.toLowerCase());
  if (hit) {
    if (hit.IsSupplier !== true) throw new Error("a customer in Xero has this name, not a supplier");
    return guid(hit.ContactID);
  }
  const email = b.supplier_email;
  const created = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create supplier ${name}`,
    input: { params: idem(`supplier:${key}`), body: { Contacts: [{ Name: name, IsSupplier: true, ...(email ? { EmailAddress: email } : {}) }] } } });
  return guid(created.data?.Contacts?.[0]?.ContactID);
}

/** A bill from this supplier with this number already in Xero (any status). Returns its id, or undefined. */
export async function existingBill(ctx: Ctx<Settings>, invoiceNo: string, contactId: string): Promise<string | undefined> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `check bill ${invoiceNo} is not in Xero`,
    input: { params: { InvoiceNumbers: invoiceNo, ContactIDs: contactId, summaryOnly: true } } });
  const hit = (r.data?.Invoices ?? []).find((i: any) => i.Type === "ACCPAY");
  return hit ? guid(hit.InvoiceID) : undefined;
}

/** The purchase order with this number: its id and its subtotal ex GST, or undefined when not found in the first pages. */
export async function purchaseOrder(ctx: Ctx<Settings>, po: string): Promise<{ id: string; subtotal: number } | undefined> {
  for (let page = 1; page <= PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getPurchaseOrders", summary: `find purchase order ${po} (page ${page})`,
      input: { params: { page } } });
    const rows: any[] = r.data?.PurchaseOrders ?? [];
    const hit = rows.find((o) => String(o.PurchaseOrderNumber ?? "") === po);
    if (hit) return { id: guid(hit.PurchaseOrderID), subtotal: Number(hit.SubTotal) };
    if (rows.length < 100) break;
  }
  return undefined;
}

/** Enter the bill as a DRAFT ACCPAY invoice. Amounts are ex GST, so LineAmountTypes is Exclusive. Returns the invoice id. */
export async function enterBill(ctx: Ctx<Settings>, key: string, b: Bill, contactId: string): Promise<string> {
  const tax = ctx.settings.default_tax_type ?? "INPUT";
  const body = { Invoices: [{ Type: "ACCPAY", Status: "DRAFT", Contact: { ContactID: contactId }, Date: b.date,
    ...(b.due_date ? { DueDate: b.due_date } : {}), InvoiceNumber: b.invoice_number, ...(b.po_number ? { Reference: `PO ${b.po_number}` } : {}),
    LineAmountTypes: "Exclusive",
    LineItems: b.lines.map((l) => ({ Description: l.description.slice(0, 4000), Quantity: 1, UnitAmount: l.amount, AccountCode: l.account_code, TaxType: l.tax_type ?? tax })) }] };
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `enter bill ${b.invoice_number} from ${b.supplier} as DRAFT`,
    input: { params: idem(`bill:${key}`), body } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}

/** The live act that authorises an entered bill. It is only ever queued; a person approves it. */
export function authoriseAct(key: string, b: Bill, invoiceId: string): Act {
  return { platform: P, op: "accounting.updateOrCreateInvoices", key: `authorise:${key}`,
    summary: `authorise bill ${b.invoice_number} from ${b.supplier} for ${money(total(b.lines))} ex GST in Xero`,
    input: { params: idem(`authorise:${key}`), body: { Invoices: [{ InvoiceID: invoiceId, Status: "AUTHORISED" }] } } };
}

/** Authorised supplier bills, every page, for the overdue list. Read only. */
export async function authorisedBills(ctx: Ctx<Settings>): Promise<{ id: string; number: string; supplier: string; due: string; owing: number }[]> {
  const out: { id: string; number: string; supplier: string; due: string; owing: number }[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `read authorised bills (page ${page})`,
      input: { params: { where: 'Type=="ACCPAY"', Statuses: "AUTHORISED", page } } });
    const rows: any[] = r.data?.Invoices ?? [];
    for (const i of rows) {
      if (!GUID.test(String(i.InvoiceID ?? ""))) continue;
      out.push({ id: String(i.InvoiceID), number: String(i.InvoiceNumber ?? ""), supplier: String(i.Contact?.Name ?? ""), due: xeroDay(i.DueDate), owing: Number(i.AmountDue ?? 0) });
    }
    if (rows.length < 100) break;
  }
  return out;
}
