// Rex feedback.search: official Feedback reference, saved 11 Nov 2026. Inspection means a property viewing.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";
export async function viewingFeedback(ctx: Ctx<Settings>) {
  const records: Record<string, { id: string; date: string; note: string; listing?: string }> = {};
  const seen = new Set<string>(); let offset = 0, total = 0;
  for (let page = 0; page < 50; page++) {
    const r = await ctx.draft<any>({ platform: "rex", op: "feedback.search", summary: `viewing feedback page ${page + 1}`, input: { params: { limit: 50, offset } } });
    if (r.data?.error || !Array.isArray(r.data?.result?.rows)) throw new Error("rex: invalid feedback search response");
    const rows = r.data.result.rows;
    if (r.data.result.total != null) {
      const n = Number(r.data.result.total);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("rex: invalid feedback total");
      total = Math.max(total, n);
    }
    if (!rows.length) {
      if (seen.size < total) throw new Error("rex: incomplete feedback list");
      await ctx.store.put("rex-viewings", "current", { read_at: ctx.now.toISOString(), records });
      return { viewings: Object.keys(records).length };
    }
    offset += rows.length;
    for (const row of rows) {
      const id = String(row?.id ?? "");
      if (!/^[1-9]\d{0,11}$/.test(id) || seen.has(id)) throw new Error("rex: invalid or repeated feedback id");
      seen.add(id);
      if (row.feedback_type?.id !== "inspection" || (row.system_record_state && row.system_record_state !== "active")) continue;
      records[id] = { id, date: String(row.date_of ?? ""), note: String(row.note ?? "").slice(0, 10000), listing: row.listing?.id == null ? undefined : String(row.listing.id) };
    }
  }
  throw new Error("rex: feedback page limit exceeded");
}
