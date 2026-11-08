// Xero: the purchase order and the supplier bill. A purchase order is created as DRAFT (nobody outside the business
// sees it); setting it AUTHORISED is the award, and it is only ever queued for a person to approve.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Quote, type Settings, EMAIL, day } from "../types.ts";

const P = "xero";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
/** Xero ignores a repeated create with the same key, so a retried run never makes a second purchase order. */
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });

/** The supplier's Xero contact, found by email. Undefined when there is none: the workflow parks the quote instead. */
export async function findContact(ctx: Ctx<Settings>, email: string): Promise<string | undefined> {
  if (!EMAIL.test(email)) return undefined;
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: "find supplier contact", input: { params: { searchTerm: email, summaryOnly: true } } });
  const hit = (r.data?.Contacts ?? []).find((c: any) => String(c.EmailAddress ?? "").toLowerCase() === email.toLowerCase());
  return hit ? guid(hit.ContactID) : undefined;
}

/** A DRAFT purchase order for one package from one supplier, at the amount the owner put in the register. */
export async function draftPurchaseOrder(ctx: Ctx<Settings>, q: Quote, contact: string, amount: number): Promise<{ id: string; number?: string }> {
  const body = { PurchaseOrders: [{ Contact: { ContactID: contact }, Date: day(ctx.now), Status: "DRAFT", Reference: q.key.slice(0, 255),
    LineItems: [{ Description: `${q.package}: quote from ${q.supplier}`.slice(0, 4000), Quantity: 1, UnitAmount: amount }] }] };
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createPurchaseOrders", summary: `draft PO for ${q.package}`, input: { params: idem(`po:${q.key}`), body } });
  const po = r.data?.PurchaseOrders?.[0];
  return { id: guid(po?.PurchaseOrderID), number: po?.PurchaseOrderNumber ? String(po.PurchaseOrderNumber).slice(0, 60) : undefined };
}

/** The award: set the purchase order AUTHORISED. Only ever queued, never run by a cron. */
export function awardAct(purchaseOrderId: string, label: string): Act {
  const id = guid(purchaseOrderId);
  return { platform: P, op: "accounting.updatePurchaseOrder", summary: `set PO ${label} AUTHORISED in Xero`,
    input: { params: { PurchaseOrderID: id, ...idem(`award:${id}`) }, body: { PurchaseOrders: [{ PurchaseOrderID: id, Status: "AUTHORISED" }] } } };
}

/** Authorised and paid supplier bills, first page only. */
export async function bills(ctx: Ctx<Settings>): Promise<any[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: "read supplier bills",
    input: { params: { where: 'Type=="ACCPAY"', Statuses: "AUTHORISED,PAID", page: 1, pageSize: 100 } } });
  return r.data?.Invoices ?? [];
}
