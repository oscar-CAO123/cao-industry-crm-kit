// Monday: the production board. Reads the orders and their status, delivery date and factory; writes the status
// column only (an internal record). Monday's API is GraphQL, so each reply comes back as { data: { <field>: ... } }.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type MondayItem, ITEM_ID } from "../types.ts";

const P = "monday";
const COLUMN = /^[a-z0-9_]{1,60}$/i;

function columnsOk(s: Settings): void {
  const ids = [s.monday.columns.status, s.monday.columns.factory, s.monday.columns.delivery];
  if (!ITEM_ID.test(String(s.monday.board_id)) || !ids.every((id) => COLUMN.test(id))) throw new Error("monday: bad board or column id in settings");
}
const textOf = (cols: any[] | undefined, id: string) => String((cols ?? []).find((c) => c?.id === id)?.text ?? "").slice(0, 200);

/** Every item on the production board (paged), with the three columns the workflow reads. */
export async function boardItems(ctx: Ctx<Settings>): Promise<MondayItem[]> {
  columnsOk(ctx.settings);
  const m = ctx.settings.monday, out: MondayItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "query.items_page_by_column_values", summary: "read production board",
      input: { params: { board_id: m.board_id, limit: 100, ...(cursor ? { cursor } : {}) }, select: "cursor items { id name column_values { id text } }" } });
    const res = r.data?.data?.items_page_by_column_values;
    for (const it of res?.items ?? []) {
      const id = String(it?.id ?? "");
      if (!ITEM_ID.test(id)) continue;
      out.push({ id, name: String(it.name ?? "").slice(0, 200), status: textOf(it.column_values, m.columns.status),
                 factory: textOf(it.column_values, m.columns.factory), delivery: textOf(it.column_values, m.columns.delivery) });
    }
    cursor = res?.cursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

/** Set the status column of one order to a label on the board (a draft: internal record only). */
export async function setStatus(ctx: Ctx<Settings>, itemId: string, label: string): Promise<void> {
  columnsOk(ctx.settings);
  if (!ITEM_ID.test(itemId)) throw new Error("monday: bad item id");
  const m = ctx.settings.monday;
  await ctx.draft<any>({ platform: P, op: "mutation.change_multiple_column_values", summary: `set status ${label} on order ${itemId}`,
    input: { params: { board_id: m.board_id, item_id: itemId, column_values: JSON.stringify({ [m.columns.status]: { label } }) }, select: "id" } });
}
