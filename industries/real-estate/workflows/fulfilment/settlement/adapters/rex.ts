// Rex: the sale contract holds the settlement date. Reads only. Rex is an RPC API: every call is a POST to https://{host}/v1/rex/<service>/<method>
// (api-docs.rexsoftware.com, read 11 Nov 2026). contracts.search takes limit and offset in the body and answers { result: { rows, total }, error };
// a contract row carries contract_status (the sample shows "offer"), date_expec_settlement and date_actual_settlement (YYYY-MM-DD or null),
// listing { id } and an id. A contract is settled once date_actual_settlement is set. The update call's page does not show where the contract id
// goes in its body, so no date is written to Rex: a difference is flagged for a person to change in Rex.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { isDay, type Settings } from "../types.ts";

const P = "rex";
export const MAX_PAGES = 50;
const LIMIT = 50;
const ID = /^[1-9]\d{0,11}$/;

export interface RexContract { id: string; status: string; expected?: string; settled: boolean; listing?: string }

export function contractStatuses(ctx: Ctx<Settings>): string[] {
  const s = ctx.settings.rex?.contract_statuses;
  if (!Array.isArray(s) || !s.length || s.some((x) => !/^[A-Za-z_ -]{1,40}$/.test(String(x)))) throw new Error("settlement: settings.rex.contract_statuses must list the Rex contract statuses to watch");
  return s.map((x) => String(x).toLowerCase());
}

/** Every contract, paged by rows received until an empty page. A non-list reply, a Rex error, a row with no usable id, a list shorter than Rex's total, or a list past MAX_PAGES is refused whole. */
export async function contracts(ctx: Ctx<Settings>): Promise<RexContract[]> {
  const out = new Map<string, RexContract>();
  let received = 0, expectedTotal = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "contracts.search", summary: `read contracts, page ${page + 1}`, input: { params: { limit: LIMIT, offset: received } } });
    if (r.data?.error) throw new Error("rex: the contract search returned an error");
    const totalValue = r.data?.result?.total;
    if (totalValue != null) {
      const total = Number(totalValue);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error("rex: invalid contract total");
      expectedTotal = Math.max(expectedTotal, total);
    }
    const rows = r.data?.result?.rows;
    if (!Array.isArray(rows)) throw new Error("rex: the contract search did not come back as a list");
    if (rows.length === 0) {
      const total = expectedTotal;
      if (out.size < total) throw new Error(`rex: the contract list came back short (${received} of ${total}); refused whole`);
      return [...out.values()];
    }
    received += rows.length;
    for (const x of rows) {
      const id = String(x?.id ?? "");
      if (!ID.test(id)) throw new Error("rex: a contract row came back with no usable id; the list is refused whole");
      if (out.has(id)) throw new Error("rex: repeated contract in paginated results; refused whole");
      out.set(id, { id, status: String(x.contract_status ?? "").trim().toLowerCase().slice(0, 40), expected: isDay(x.date_expec_settlement),
        settled: !!x.date_actual_settlement, listing: x.listing?.id != null && ID.test(String(x.listing.id)) ? String(x.listing.id) : undefined });
    }
  }
  throw new Error(`rex: the contract list is longer than ${MAX_PAGES} pages; refused whole`);
}
