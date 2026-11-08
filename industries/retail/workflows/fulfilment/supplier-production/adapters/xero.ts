// Xero: factory contacts, purchase orders, deposit bills and payments. Drafts (a contact, a PO in DRAFT, a bill in DRAFT)
// reach nobody outside the business. Authorising a PO or a bill, and paying, are returned as acts for the approval queue.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Act } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Line, type RateItem, type Job, guid, keyOf, day, BANK, ISO_DAY } from "../types.ts";

const P = "xero";
/** Xero ignores a repeated create with the same key, so a retried run never makes a second contact, PO or bill. */
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });

/** Purchase prices from the Xero items list. */
export async function rateCard(ctx: Ctx<Settings>): Promise<RateItem[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getItems", summary: "read items (purchase prices)" });
  return (r.data?.Items ?? []).filter((i: any) => i.Code && Number.isFinite(Number(i.PurchaseDetails?.UnitPrice)))
    .map((i: any): RateItem => ({ code: String(i.Code), name: String(i.Name ?? i.Code).slice(0, 200), price: Number(i.PurchaseDetails.UnitPrice), ref: { item_id: String(i.ItemID ?? "") } }));
}

/** The factory as a supplier contact: find it by exact name, or create it. */
export async function supplierId(ctx: Ctx<Settings>, name: string): Promise<string> {
  const clean = name.trim().slice(0, 255);
  if (!clean) throw new Error("xero: the order has no factory name");
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: `find supplier ${clean}`, input: { params: { searchTerm: clean, summaryOnly: true } } });
  const hit = (r.data?.Contacts ?? []).find((c: any) => String(c.Name ?? "").toLowerCase() === clean.toLowerCase());
  if (hit) return guid(hit.ContactID);
  const c = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create supplier ${clean}`,
    input: { params: idem(`supplier:${clean}`), body: { Contacts: [{ Name: clean, IsSupplier: true }] } } });
  return guid(c.data?.Contacts?.[0]?.ContactID);
}

/** A purchase order in DRAFT for one order's lines. */
export async function draftPurchaseOrder(ctx: Ctx<Settings>, job: Job, contact: string, lines: Line[]): Promise<{ id: string; number?: string }> {
  const body = { PurchaseOrders: [{ Contact: { ContactID: contact }, Date: day(ctx.now), ...(job.delivery && ISO_DAY.test(job.delivery) ? { DeliveryDate: job.delivery } : {}),
    Reference: job.name.slice(0, 255), Status: "DRAFT",
    LineItems: lines.map((l) => ({ ItemCode: l.code, Description: l.name.slice(0, 4000), Quantity: l.qty, UnitAmount: l.unitCost })) }] };
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createPurchaseOrders", summary: `draft purchase order for ${job.name}`,
    input: { params: idem(`po:${job.id}`), body } });
  const po = r.data?.PurchaseOrders?.[0];
  return { id: guid(po?.PurchaseOrderID), number: po?.PurchaseOrderNumber ? String(po.PurchaseOrderNumber).slice(0, 60) : undefined };
}

/** The purchase order's status in Xero (DRAFT, SUBMITTED, AUTHORISED, BILLED, DELETED). */
export async function poStatus(ctx: Ctx<Settings>, id: string): Promise<string | undefined> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getPurchaseOrder", summary: "purchase order status", input: { params: { PurchaseOrderID: guid(id) } } });
  return r.data?.PurchaseOrders?.[0]?.Status;
}

/** Authorise a purchase order: changes the status the factory sees, so it is only ever queued for approval. */
export function authorisePoAct(poId: string, label: string): Act {
  return { platform: P, op: "accounting.updatePurchaseOrder", summary: `authorise purchase order ${label} in Xero`, key: keyOf(`authorise-po:${poId}`),
    input: { params: { PurchaseOrderID: guid(poId) }, body: { PurchaseOrders: [{ PurchaseOrderID: guid(poId), Status: "AUTHORISED" }] } } };
}

/** The deposit as a supplier bill in DRAFT, for one authorised purchase order. */
export async function draftDepositBill(ctx: Ctx<Settings>, job: Job, contact: string, amount: number): Promise<string> {
  const acct = ctx.settings.xero?.purchase_account_code;
  const body = { Invoices: [{ Type: "ACCPAY", Contact: { ContactID: contact }, Date: day(ctx.now), Status: "DRAFT",
    Reference: `Deposit ${job.po?.number ?? job.name}`.slice(0, 255),
    LineItems: [{ Description: `Deposit for ${job.name}`.slice(0, 4000), Quantity: 1, UnitAmount: amount, ...(acct && BANK.test(acct) ? { AccountCode: acct } : {}) }] }] };
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft deposit bill for ${job.name}`, input: { params: idem(`deposit:${job.id}`), body } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}

/** Authorise the deposit bill, so it can be paid. Queued with the payment, never run by a cron. */
export function authoriseBillAct(billId: string, label: string): Act {
  const id = guid(billId);
  return { platform: P, op: "accounting.updateInvoice", summary: `authorise deposit bill ${label} in Xero`, key: keyOf(`deposit:${id}`),
    input: { params: { InvoiceID: id }, body: { Invoices: [{ InvoiceID: id, Status: "AUTHORISED" }] } } };
}

/** Pay the deposit from the business bank account. Money out: only ever queued for approval. */
export function payDepositAct(billId: string, amount: number, poId: string, bank: string, when: Date): Act {
  const id = guid(billId);
  if (!BANK.test(bank)) throw new Error("xero: bad bank account code in settings");
  return { platform: P, op: "accounting.createPayment", summary: `pay deposit ${amount.toFixed(2)} on bill ${id.slice(0, 8)}`, key: keyOf(`deposit:${id}`),
    input: { params: idem(`pay:${id}`), body: { Invoice: { InvoiceID: id }, Account: { Code: bank }, Date: day(when), Amount: amount, Reference: `PO ${poId.slice(0, 8)}` } } };
}
