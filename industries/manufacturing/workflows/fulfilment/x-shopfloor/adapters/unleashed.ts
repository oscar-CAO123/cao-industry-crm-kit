// The Unleashed operations the shop-floor crons use. Each id is a mapped operation in core/sdk/platforms/unleashed/ops.json.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { GUID, type Build, type Settings, type StockRow } from "../types.ts";

export const PLATFORM = "unleashed";
export const OP = {
  builds: "docs.get_Assemblies",
  stock: "docs.get_StockOnHand",
  complete: "docs.post_Assemblies_assemblyGuid_Complete",
} as const;

/** Open builds: a read of the first page (no filters sent; the mapped operation has no page number, so paging is not built).
 *  Returns how many pages the platform holds, so a caller can record when builds on later pages were not read. */
export async function listAssemblies(ctx: Ctx<Settings>): Promise<{ builds: Build[]; pages: number }> {
  const r = await ctx.draft<{ Items?: Build[]; Pagination?: { NumberOfPages?: number } }>({ platform: PLATFORM, op: OP.builds, summary: "list builds" });
  return {
    builds: Array.isArray(r.data?.Items) ? r.data.Items : [],
    pages: Number(r.data?.Pagination?.NumberOfPages) || 1,
  };
}

/** Stock on hand by product and warehouse: a read. */
export async function listStock(ctx: Ctx<Settings>): Promise<StockRow[]> {
  const r = await ctx.draft<{ Items?: StockRow[] }>({ platform: PLATFORM, op: OP.stock, summary: "list stock on hand" });
  return Array.isArray(r.data?.Items) ? r.data.Items : [];
}

/** Completing a build changes stock, so it is only queued. One build queues once: the key is its guid.
 *  The mapped operation takes only the assemblyGuid path param and no body, so none is sent. */
export function completeAssembly(ctx: Ctx<Settings>, guid: string, summary: string): Promise<string> {
  if (!GUID.test(guid)) throw new Error(`unleashed: not a build guid`);
  return ctx.queue({
    platform: PLATFORM, op: OP.complete, summary, key: `complete-${guid}`,
    input: { params: { assemblyGuid: guid } },
  }, summary);
}
