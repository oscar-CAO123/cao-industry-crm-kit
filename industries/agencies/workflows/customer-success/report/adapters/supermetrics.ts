// Supermetrics: the numbers for one client and one month, from its data source account (a read operation).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Client, type Period, type Settings, oneLine } from "../types.ts";

const P = "supermetrics";

export const supermetrics = {
  id: P,
  /** Rows as the query returns them: the first row is the header. Values are plain text, trimmed. */
  async pull(ctx: Ctx<Settings>, c: Client, period: Period): Promise<string[][]> {
    const s = c.supermetrics;
    const r = await ctx.draft<any>({ platform: P, op: "getData", summary: `read ${c.name} ${period.start} to ${period.end}`,
      input: { params: { json: { ds_id: s.ds_id, ds_accounts: s.ds_accounts, start_date: period.start, end_date: period.end, fields: s.fields } } } });
    const rows = r.data?.data;
    if (!Array.isArray(rows)) throw new Error(`supermetrics: no rows for ${c.name}`);
    return rows.slice(0, 200).map((row: unknown) => (Array.isArray(row) ? row : []).slice(0, 50).map((v) => oneLine(v, 200)));
  },
};
