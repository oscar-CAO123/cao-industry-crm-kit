// Stripe: payouts (the net amount sent to the bank), read from balance transactions of type payout.
// Stripe amounts are in minor units (cents). A payout's balance transaction carries the payout id in `source`.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Payout, type Settings, PAYOUT_ID } from "../types.ts";

const P = "stripe";

/** Every payout created on or after sinceUnix (seconds), newest first, read a page at a time. */
export async function payouts(ctx: Ctx<Settings>, sinceUnix: number): Promise<Payout[]> {
  const out: Payout[] = [];
  let startingAfter: string | undefined;
  for (let page = 1; page <= 20; page++) {
    const params: Record<string, unknown> = { type: "payout", limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) };
    const r = await ctx.draft<any>({ platform: P, op: "openapi_spec3.GetBalanceTransactions", summary: `payouts, page ${page}`, input: { params } });
    const rows: any[] = r.data?.data ?? [];
    let oldest = Infinity;
    for (const t of rows) {
      const created = Number(t.created);
      if (!Number.isSafeInteger(created)) continue;
      oldest = Math.min(oldest, created);
      const id = String(t.source ?? "");
      const amount = Number(t.amount);
      if (t.type !== "payout" || !PAYOUT_ID.test(id) || !Number.isSafeInteger(amount) || amount >= 0 || created < sinceUnix) continue;
      out.push({ id, date: new Date(created * 1000).toISOString().slice(0, 10), amount: -amount / 100, currency: String(t.currency ?? "").slice(0, 3) });
    }
    if (!r.data?.has_more || !rows.length || oldest < sinceUnix) break;
    startingAfter = String(rows[rows.length - 1].id ?? "");
    if (!startingAfter) break;
  }
  return out;
}
