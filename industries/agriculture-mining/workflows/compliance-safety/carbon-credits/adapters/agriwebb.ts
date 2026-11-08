// AgriWebb: farms, fields and farm records, read through its GraphQL API. Reads only: the kit maps no carbon
// registry, claim, sale or payment operation, so nothing here reaches outside the farm.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

const P = "agriwebb";
const FARM = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE = 500;

export const farmId = (v: unknown): string => {
  const s = String(v ?? "");
  if (!FARM.test(s)) throw new Error("agriwebb: bad farm id");
  return s;
};

/** A GraphQL reply is the raw body: the data sits under data.<field>, and errors come back with a 200. */
function gql<T>(r: { data?: any }, field: string): T[] {
  if (r.data?.errors?.length) throw new Error(`agriwebb ${field}: ${String(r.data.errors[0].message ?? "error").slice(0, 200)}`);
  return (r.data?.data?.[field] ?? []) as T[];
}

export async function farms(ctx: Ctx<Settings>, ids: string[]): Promise<any[]> {
  const r = await ctx.draft<any>({ platform: P, op: "query.farms", summary: "read farms", input: { params: { farmIds: ids.map(farmId) } } });
  return gql<any>(r, "farms");
}

export async function fields(ctx: Ctx<Settings>, farm: string): Promise<any[]> {
  const r = await ctx.draft<any>({ platform: P, op: "query.fields", summary: `read fields for ${farm}`, input: { params: { limit: PAGE } } });
  return gql<any>(r, "fields").filter((f) => f.farmId === farm);
}

export async function records(ctx: Ctx<Settings>, farm: string): Promise<any[]> {
  const r = await ctx.draft<any>({ platform: P, op: "query.records", summary: `read records for ${farm}`, input: { params: { options: { farmId: farm, limit: PAGE } } } });
  return gql<any>(r, "records");
}
