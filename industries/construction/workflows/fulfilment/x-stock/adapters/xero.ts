// Xero: stock on hand, the supplier contact, the purchase order and the supplier bill. A purchase order is created as
// DRAFT, which nobody outside the business sees. Setting it AUTHORISED is the award, and it is only ever queued.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Request, type Settings, type StockItem, EMAIL, day } from "../types.ts";

const P = "xero";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
/** Xero ignores a repeated create with the same key, so a retried run never makes a second purchase order. */
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const xero = {
  /** Items Xero tracks as inventory, with the on-hand quantity and the purchase unit price. */
  async stockOnHand(ctx: Ctx<Settings>): Promise<StockItem[]> {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getItems", summary: "read stock on hand" });
    const out: StockItem[] = [];
    for (const i of r.data?.Items ?? []) {
      const onHand = num(i.QuantityOnHand);
      if (!i.Code || onHand === null) continue;
      out.push({ id: String(i.ItemID ?? ""), code: String(i.Code).slice(0, 50), name: String(i.Name ?? i.Code).slice(0, 200),
                 onHand, unitPrice: num(i.PurchaseDetails?.UnitPrice) });
    }
    return out;
  },
  /** The supplier's Xero contact, found by email. Undefined when there is none, and the request is skipped. */
  async contactByEmail(ctx: Ctx<Settings>, email: string): Promise<string | undefined> {
    if (!EMAIL.test(email)) return undefined;
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: "find supplier contact",
      input: { params: { searchTerm: email, summaryOnly: true } } });
    const hit = (r.data?.Contacts ?? []).find((c: any) => String(c.EmailAddress ?? "").toLowerCase() === email.toLowerCase());
    return hit ? guid(hit.ContactID) : undefined;
  },
  /** A DRAFT purchase order for one restock line. */
  async draftPo(ctx: Ctx<Settings>, r: Request, contact: string): Promise<{ id: string; number?: string }> {
    const body = { PurchaseOrders: [{ Contact: { ContactID: contact }, Date: day(ctx.now), Status: "DRAFT", Reference: r.key.slice(0, 255),
      LineItems: [{ ItemCode: r.code, Description: `Restock ${r.name}`.slice(0, 4000), Quantity: r.qty, UnitAmount: Number(r.unitPrice) }] }] };
    const res = await ctx.draft<any>({ platform: P, op: "accounting.createPurchaseOrders", summary: `draft PO for ${r.code}`,
      input: { params: idem(`po:${r.key}`), body } });
    const po = res.data?.PurchaseOrders?.[0];
    return { id: guid(po?.PurchaseOrderID), number: po?.PurchaseOrderNumber ? String(po.PurchaseOrderNumber).slice(0, 60) : undefined };
  },
  /** Authorised purchase orders, first page: what a supplier bill is matched against. */
  async openOrders(ctx: Ctx<Settings>): Promise<any[]> {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getPurchaseOrders", summary: "read open purchase orders",
      input: { params: { Status: "AUTHORISED", page: 1, pageSize: 100 } } });
    return r.data?.PurchaseOrders ?? [];
  },
  /** Supplier bills, first page. */
  async bills(ctx: Ctx<Settings>): Promise<any[]> {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: "read supplier bills",
      input: { params: { where: 'Type=="ACCPAY"', Statuses: "AUTHORISED,PAID", page: 1, pageSize: 100 } } });
    return r.data?.Invoices ?? [];
  },
};

/** The award: set one purchase order AUTHORISED. Only ever queued for a person; a cron never runs it. */
export function awardAct(poId: string, label: string, key: string): Act {
  const id = guid(poId);
  return { platform: P, op: "accounting.updatePurchaseOrder", key, summary: `set PO ${label} AUTHORISED in Xero`,
    input: { params: { PurchaseOrderID: id, ...idem(`award:${id}`) }, body: { PurchaseOrders: [{ PurchaseOrderID: id, Status: "AUTHORISED" }] } } };
}
