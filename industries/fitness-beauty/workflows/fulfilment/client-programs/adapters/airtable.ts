// Airtable: the business's own base holds clients, programs, sessions and progress. Every operation here is a draft
// operation (an internal row). Table and field names come from settings, because each base names its own.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type AtRecord, BASE_ID, RECORD_ID, TABLE } from "../types.ts";

const P = "airtable";

const cfg = (ctx: Ctx<Settings>) => {
  const a = ctx.settings.airtable;
  if (!BASE_ID.test(a?.base_id ?? "")) throw new Error("airtable.base_id is not set or is not an Airtable base id");
  for (const t of Object.values(a.tables)) if (!TABLE.test(t)) throw new Error("airtable: a table name is not allowed");
  return a;
};
const recordId = (id: unknown) => {
  const s = String(id ?? "");
  if (!RECORD_ID.test(s)) throw new Error("airtable: bad record id");
  return s;
};

/** Every row of one table, following Airtable's offset pages (capped so one run cannot loop forever). */
export async function listRecords(ctx: Ctx<Settings>, table: string): Promise<AtRecord[]> {
  const a = cfg(ctx);
  if (!TABLE.test(table)) throw new Error("airtable: bad table name");
  const out: AtRecord[] = [];
  let offset: string | undefined;
  for (let page = 0; page < 20; page++) {
    const params: Record<string, unknown> = { baseId: a.base_id, tableIdOrName: table, pageSize: 100, ...(offset ? { offset } : {}) };
    const r = await ctx.draft<any>({ platform: P, op: "docs.get_baseId_tableIdOrName", summary: `read ${table}`, input: { params } });
    for (const x of r.data?.records ?? []) if (RECORD_ID.test(String(x?.id ?? ""))) out.push({ id: x.id, createdTime: x.createdTime, fields: x.fields ?? {} });
    offset = typeof r.data?.offset === "string" ? r.data.offset : undefined;
    if (!offset) break;
  }
  return out;
}

/** Create one row (a draft operation). Returns the new record id. */
export async function createRecord(ctx: Ctx<Settings>, table: string, fields: Record<string, unknown>): Promise<string> {
  const a = cfg(ctx);
  if (!TABLE.test(table)) throw new Error("airtable: bad table name");
  const r = await ctx.draft<any>({ platform: P, op: "docs.post_baseId_tableIdOrName", summary: `add to ${table}`, input: {
    params: { baseId: a.base_id, tableIdOrName: table }, body: { records: [{ fields }] } } });
  return recordId(r.data?.records?.[0]?.id);
}

/** Change cells on one row (a draft operation). */
export async function updateRecord(ctx: Ctx<Settings>, table: string, id: string, fields: Record<string, unknown>): Promise<void> {
  const a = cfg(ctx);
  if (!TABLE.test(table)) throw new Error("airtable: bad table name");
  await ctx.draft({ platform: P, op: "docs.patch_baseId_tableIdOrName_recordId", summary: `update ${table} row`, input: {
    params: { baseId: a.base_id, tableIdOrName: table, recordId: recordId(id) }, body: { fields } } });
}

export const airtable = { id: P, listRecords, createRecord, updateRecord };
