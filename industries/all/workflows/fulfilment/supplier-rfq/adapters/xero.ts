// Xero: the purchase order for the awarded supplier is drafted (DRAFT reaches nobody), and the move to AUTHORISED is only
// ever queued for a person to approve.
import { type Act, type Ctx, safeKey } from "../../../../../../core/workflows/runtime.ts";
import type { Rfq, Settings } from "../types.ts";
import { day } from "../types.ts";

const P = "xero";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Draft the purchase order (a draft operation). Returns the Xero PurchaseOrderID. */
async function draftPurchaseOrder(ctx: Ctx<Settings>, rfq: Rfq): Promise<string> {
  const a = rfq.award;
  if (!a) throw new Error(`xero: RFQ ${rfq.id} has no award`);
  if (!UUID.test(a.xero_contact_id)) throw new Error(`xero: RFQ ${rfq.id} award has no valid Xero contact id`);
  for (const l of a.lines) if (!(l.qty > 0) || !(l.unitPrice >= 0)) throw new Error(`xero: RFQ ${rfq.id} has a bad line quantity or price`);
  // Xero ignores a repeated create with the same key, so a lost reply or a retry never makes a second draft order.
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createPurchaseOrders", summary: `draft purchase order for RFQ ${rfq.id}`, input: { params: { "Idempotency-Key": safeKey(`rfq-po:${rfq.id}`, 120) }, body: { PurchaseOrders: [{
    Contact: { ContactID: a.xero_contact_id }, Reference: `RFQ ${rfq.id}`, Date: day(ctx.now), Status: "DRAFT",
    LineItems: a.lines.map((l) => ({ Description: l.item.slice(0, 4000), Quantity: l.qty, UnitAmount: l.unitPrice })) }] } } });
  const id = String(r.data?.PurchaseOrders?.[0]?.PurchaseOrderID ?? "");
  if (!UUID.test(id)) throw new Error(`xero: purchase order for RFQ ${rfq.id} not created`);
  return id;
}

/** Authorising a purchase order is what the supplier sees: always a live act, queued for approval. */
function authoriseAct(poId: string, rfqId: string): Act {
  return { platform: P, op: "accounting.updatePurchaseOrder", summary: `authorise purchase order for RFQ ${rfqId}`, key: `authorise:${rfqId}`,
    input: { params: { PurchaseOrderID: poId }, body: { PurchaseOrders: [{ PurchaseOrderID: poId, Status: "AUTHORISED" }] } } };
}

export const xero = { id: P, draftPurchaseOrder, authoriseAct };
