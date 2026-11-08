// Domain: the price estimate for a property, read only. The path parameter (propertyId) is confirmed in the vendor page;
// the response fields are not, so the reply is returned as the vendor sent it and nothing reads named fields from it.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

export const P = "domain";
const ID = /^[A-Za-z0-9_-]{1,40}$/;

export async function priceEstimate(ctx: Ctx<Settings>, domainId: unknown): Promise<unknown> {
  const id = String(domainId ?? "");
  if (!ID.test(id)) throw new Error("domain: bad property id");
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_v1_properties_propertyId_priceEstimate", summary: `price estimate ${id}`,
    input: { params: { propertyId: id } } });
  if (r.status >= 300) throw new Error(`domain: price estimate returned ${r.status}`);
  return r.data;
}
