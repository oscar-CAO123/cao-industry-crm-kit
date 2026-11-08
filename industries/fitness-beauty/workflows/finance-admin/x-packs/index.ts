// The packs and gift cards workflow's two crons. Each only reads a platform and writes a snapshot to the workflow's own store.
// No live operation is mapped for this job, so nothing is queued and nothing is sent, paid or changed.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, Snapshot } from "./types.ts";
import { listGiftCards } from "./adapters/square.ts";
import { trialBalance } from "./adapters/xero.ts";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Daily: what value gift cards still hold. One snapshot per day; a re-run the same day overwrites that day's snapshot. */
export async function giftCardBalances(ctx: Ctx<Settings>) {
  const { rows, skipped, truncated } = await listGiftCards(ctx);
  const date = iso(ctx.now);
  const snap: Snapshot = { date, cards: rows.length, total_cents: rows.reduce((a, r) => a + r.cents, 0), skipped, truncated, rows };
  await ctx.store.put("gift-card-balances", date, snap);
  ctx.log(`gift-card-balances: ${snap.cards} cards, ${skipped} skipped${truncated ? ", truncated" : ""}`);
  return { cards: snap.cards, total_cents: snap.total_cents, skipped, truncated };
}

/** Monthly: the trial balance at the last day of last month, kept for the bookkeeper to match against deferred income. */
export async function reconcileDeferred(ctx: Ctx<Settings>) {
  const date = iso(new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 0)));
  const report = await trialBalance(ctx, date);
  await ctx.store.put("trial-balance", date, { date, report });
  ctx.log(`reconcile-deferred: trial balance at ${date} kept`);
  return { date };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "gift-card-balances": giftCardBalances,
  "reconcile-deferred": reconcileDeferred,
};
