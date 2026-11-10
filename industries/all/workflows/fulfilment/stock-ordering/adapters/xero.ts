// Xero: stock on hand and purchase orders. Reads and DRAFT purchase orders are draft operations: a DRAFT reaches nobody.
// Authorising a purchase order commits the business to the supplier, so it is only ever built here as a queued act.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type PoStatus, GUID, PO_STATUS, day, str } from "../types.ts";

const P = "xero";
const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };

export interface XeroItem { ItemID?: unknown; Code?: unknown; Name?: unknown; QuantityOnHand?: unknown; PurchaseDetails?: { UnitPrice?: unknown } }

/** Every item in Xero, read in one call. Stock on hand is reported only for items tracked as inventory. */
export async function readItems(ctx: Ctx<Settings>): Promise<XeroItem[]> {
  const r = await ctx.draft<{ Items?: XeroItem[] }>({ platform: P, op: "accounting.getItems", summary: "read items and stock on hand" });
  return Array.isArray(r.data?.Items) ? r.data!.Items! : [];
}

/** Creates a DRAFT purchase order for one item. Xero ignores a repeated create with the same key, so a retry never makes a second order. */
export async function createDraftPo(ctx: Ctx<Settings>, o: { code: string; name: string; qty: number; unit_cost: number; supplier: string; delivery: Date; key: string }): Promise<string> {
  const body = { PurchaseOrders: [{
    Contact: { ContactID: guid(o.supplier) }, Date: day(ctx.now), DeliveryDate: day(o.delivery), Status: "DRAFT",
    Reference: `Reorder ${o.code}`.slice(0, 255),
    LineItems: [{ ItemCode: o.code, Description: str(o.name, 4000) || o.code, Quantity: o.qty, UnitAmount: o.unit_cost }],
  }] };
  const r = await ctx.draft<{ PurchaseOrders?: { PurchaseOrderID?: unknown }[] }>({ platform: P, op: "accounting.createPurchaseOrders",
    summary: `draft purchase order for ${o.qty} x ${o.code}`, input: { params: { "Idempotency-Key": safeKey(`po:${o.key}`, 120) }, body } });
  return guid(r.data?.PurchaseOrders?.[0]?.PurchaseOrderID);
}

/** The act that authorises a purchase order. Queued only: a person approves it in the CRM shell. */
export function authoriseAct(poId: string, summary: string): Act {
  const id = guid(poId);
  return { platform: P, op: "accounting.updatePurchaseOrder", key: `authorise:${id}`, summary,
    input: { params: { PurchaseOrderID: id }, body: { PurchaseOrders: [{ PurchaseOrderID: id, Status: "AUTHORISED" }] } } };
}

/** The status Xero holds for a purchase order, or null when the reply does not carry one we know. */
export async function readPo(ctx: Ctx<Settings>, poId: string): Promise<PoStatus | null> {
  const r = await ctx.draft<{ PurchaseOrders?: { Status?: unknown }[] }>({ platform: P, op: "accounting.getPurchaseOrder",
    summary: `purchase order status ${poId}`, input: { params: { PurchaseOrderID: guid(poId) } } });
  const s = r.data?.PurchaseOrders?.[0]?.Status;
  return PO_STATUS.includes(s as PoStatus) ? (s as PoStatus) : null;
}
