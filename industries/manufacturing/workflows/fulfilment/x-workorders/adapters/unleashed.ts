// Unleashed: work orders are Assemblies. A parked assembly is a draft (it moves no stock). Completing one moves stock,
// so completion is only ever returned as an act for the runtime to queue. Field names come from Unleashed's
// Assemblies, Products and Stock On Hand pages in the endpoint map. Core signs every Unleashed request; no call here
// has yet run against a live account.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Act } from "../../../../../../core/workflows/runtime.ts";
import { CODE, GUID, type Settings, type WorkOrder, type StockLine } from "../types.ts";

const P = "unleashed";
const items = (data: any): any[] => (Array.isArray(data?.Items) ? data.Items : []);

function toOrder(a: any): WorkOrder | undefined {
  const guid = String(a?.Guid ?? ""), code = String(a?.Product?.ProductCode ?? "");
  if (!GUID.test(guid) || !CODE.test(code)) return undefined;
  return {
    guid, number: String(a.AssemblyNumber ?? "").slice(0, 40), status: String(a.AssemblyStatus ?? "").slice(0, 40), product_code: code,
    quantity: Number(a.Quantity) || 0, due: a.AssembleBy ? String(a.AssembleBy).slice(0, 10) : undefined,
    comments: a.Comments ? String(a.Comments).slice(0, 300) : undefined,
  };
}

/** Parked work orders (first page of 200). */
export async function parkedOrders(ctx: Ctx<Settings>): Promise<WorkOrder[]> {
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_Assemblies", summary: "read parked work orders",
    input: { params: { assemblyStatus: "Parked", pageSize: 200 } } });
  return items(r.data).map(toOrder).filter((o): o is WorkOrder => !!o);
}

/** Stock on hand in the production warehouse (first page). */
export async function stockAt(ctx: Ctx<Settings>): Promise<StockLine[]> {
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_StockOnHand", summary: "read stock on hand",
    input: { params: { warehouseCode: ctx.settings.warehouse_code } } });
  return items(r.data)
    .map((s) => ({ product_code: String(s?.ProductCode ?? ""), qty_on_hand: Number(s?.QtyOnHand) || 0 }))
    .filter((s) => CODE.test(s.product_code));
}

/** Park one work order (a draft: it moves no stock). Returns the new assembly's guid. */
export async function raiseParked(ctx: Ctx<Settings>, productCode: string, quantity: number, due: string, comments: string): Promise<string> {
  const wh = { WarehouseCode: ctx.settings.warehouse_code };
  const r = await ctx.draft<any>({ platform: P, op: "docs.post_Assemblies", summary: `park work order ${productCode} x${quantity}`,
    input: { body: { Product: { ProductCode: productCode }, Quantity: quantity, AssembleBy: `${due}T00:00:00`,
                     SourceWarehouse: wh, DestinationWarehouse: wh, Comments: comments.slice(0, 1024) } } });
  const guid = String(r.data?.Guid ?? r.headers.get("x-record-uuid") ?? "");
  if (!GUID.test(guid)) throw new Error(`unleashed: no guid back for ${productCode}`);
  return guid;
}

/** The act that completes a work order. Completing moves stock, so the cron queues it and a person approves it. */
export function completeAct(o: WorkOrder): Act {
  return { platform: P, op: "docs.post_Assemblies_assemblyGuid_Complete", key: `complete:${o.guid}`,
    input: { params: { assemblyGuid: o.guid } }, summary: `complete work order ${o.number} (${o.quantity} x ${o.product_code})` };
}
