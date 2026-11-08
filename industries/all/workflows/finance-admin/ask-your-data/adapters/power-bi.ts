// Power BI: one fixed DAX query per named question, run against the business's dataset. The DAX text comes only from
// settings the business agreed; a question's words never become a query. The op is a POST, which the kit classes as a
// write, so it runs only where the deploy sets KIT_ALLOW_WRITES=1 (see gaps in workflow.json).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Figure, type Settings } from "../types.ts";

const P = "power-bi";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function powerBiRows(ctx: Ctx<Settings>, datasetId: string, dax: string): Promise<Figure[]> {
  if (!GUID.test(datasetId)) throw new Error("power-bi: bad dataset id");
  const r = await ctx.draft<any>({ platform: P, op: "Datasets_ExecuteQueries", summary: "run a fixed DAX query",
    input: { params: { datasetId }, body: { queries: [{ query: dax }], serializerSettings: { includeNulls: false } } } });
  const err = r.data?.error ?? r.data?.results?.[0]?.error;
  if (err) throw new Error(`power-bi: ${String(err.message ?? "query error").slice(0, 120)}`);
  const rows: Record<string, unknown>[] = r.data?.results?.[0]?.tables?.[0]?.rows ?? [];
  return rows.slice(0, 50).flatMap((row) => Object.entries(row).map(([k, v]): Figure => ({ label: k.slice(0, 120), value: String(v ?? "").slice(0, 60) })))
    .slice(0, 200);
}
