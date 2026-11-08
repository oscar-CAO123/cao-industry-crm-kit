// Airtable: reads the product, recipe and ingredient tables and creates draft rows in the Drafts table.
// Base and table ids are checked before they go into a path. Airtable ids are "app..." (base), "tbl..." (table), "rec..." (record).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Row, Settings } from "../types.ts";

const P = "airtable";
const BASE = /^app[A-Za-z0-9]{14}$/, TABLE = /^tbl[A-Za-z0-9]{14}$/, REC = /^rec[A-Za-z0-9]{14}$/;

/** The configured ids, checked. Throws before any network call when one is malformed. */
export function ids(s: Settings) {
  const a = s.airtable;
  if (!BASE.test(a.base_id)) throw new Error("food-labels: airtable.base_id must look like app... (Airtable base id)");
  for (const t of [a.products_table, a.recipe_table, a.ingredients_table, a.drafts_table]) {
    if (!TABLE.test(t)) throw new Error("food-labels: every airtable table must be a tbl... table id");
  }
  return a;
}

/** Every record in one page of a table (Airtable returns up to 100). */
export async function readTable(ctx: Ctx<Settings>, table: string): Promise<Row[]> {
  const a = ids(ctx.settings);
  const r = await ctx.draft<{ records?: Row[] }>({ platform: P, op: "docs.get_baseId_tableIdOrName", summary: `read table ${table}`,
    input: { params: { baseId: a.base_id, tableIdOrName: table } } });
  if (r.status >= 300) throw new Error(`food-labels: reading a table failed with status ${r.status}`);
  return (r.data?.records ?? []).filter((x): x is Row => !!x && typeof x.id === "string" && REC.test(x.id) && !!x.fields && typeof x.fields === "object");
}

/** One draft row in the Drafts table. Returns the new record id. */
export async function createDraft(ctx: Ctx<Settings>, fields: Record<string, unknown>): Promise<string> {
  const a = ids(ctx.settings);
  const r = await ctx.draft<{ records?: { id?: string }[] }>({ platform: P, op: "docs.post_baseId_tableIdOrName", summary: `draft row for ${String(fields.Product)}`,
    input: { params: { baseId: a.base_id, tableIdOrName: a.drafts_table }, body: { records: [{ fields }] } } });
  const id = r.data?.records?.[0]?.id;
  if (r.status >= 300 || !id || !REC.test(id)) throw new Error(`food-labels: draft row was not created (status ${r.status})`);
  return id;
}
