// AgriWebb: paddock reads only. Field fields come from AgriWebb's official schema: Field { id name farmId totalArea unit
// landUse cropType lastModifiedDate }, filtered by FieldFilter.farmId. AgriWebb has no crop or spray record write, so
// nothing here writes to it.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Paddock, PLAIN_ID } from "../types.ts";

const P = "agriwebb";
const FIELD_SELECT = "id name farmId totalArea unit landUse cropType lastModifiedDate";

/** The paddocks of each watched farm. Farm ids and paddock ids that fail the plain-id check are dropped. */
export async function paddocksFor(ctx: Ctx<Settings>): Promise<Paddock[]> {
  const farms = (ctx.settings.agriwebb?.farm_ids ?? []).filter((f) => PLAIN_ID.test(String(f))).slice(0, 5);
  const out: Paddock[] = [];
  for (const farmId of farms) {
    const r = await ctx.draft<{ data?: { fields?: Paddock[] } }>({ platform: P, op: "query.fields", summary: "read paddocks",
      input: { params: { filter: { farmId: { _eq: farmId } }, limit: 500 }, select: FIELD_SELECT } });
    const rows = Array.isArray(r.data?.data?.fields) ? r.data!.data!.fields! : [];
    out.push(...rows.filter((f) => PLAIN_ID.test(String(f.id ?? ""))));
  }
  return out;
}
