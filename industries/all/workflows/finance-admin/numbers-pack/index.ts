// The numbers pack's three crons. Each reads and stores or drafts; none sends, pays or changes the ledger.
// The pack is an internal draft the owner reads. Commentary is judgment and is left for the owner or the agent skill.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, Snapshot } from "./types.ts";
import { periodFor, day, packHtml } from "./types.ts";
import { profitAndLoss, bankSummary } from "./adapters/xero.ts";

const DAY_MS = 864e5;

function ledgerOk(s: Settings) {
  if (s.ledger !== "xero") throw new Error(`numbers-pack: ${String(s.ledger)} has no adapter yet`);
}

/** Daily: on a due day (each Sunday for weekly, the last day of the month for monthly) read the profit and loss for the period. */
export async function dataPull(ctx: Ctx<Settings>) {
  ledgerOk(ctx.settings);
  const { due, period } = periodFor(ctx.now, ctx.settings.cadence);
  if (!due) return { skipped: "period not due" };
  const r = await profitAndLoss(ctx, period);
  await ctx.store.put("snapshots", period.key, { key: period.key, kind: "profit-and-loss", source: "xero", period, ...r, pulled: ctx.now.toISOString() } satisfies Snapshot);
  ctx.log(`data-pull: profit and loss ${period.start} to ${period.end}, ${r.rows.length} rows`);
  return { stored: period.key, rows: r.rows.length };
}

/** Daily: the bank summary for the last seven days, kept so the pack can show the bank position. */
export async function cashCheck(ctx: Ctx<Settings>) {
  ledgerOk(ctx.settings);
  const end = day(ctx.now), start = day(new Date(ctx.now.getTime() - 6 * DAY_MS));
  const r = await bankSummary(ctx, { key: `${start}_${end}`, start, end });
  await ctx.store.put("bank", end, { key: end, kind: "bank-summary", source: "xero", period: { key: `${start}_${end}`, start, end }, ...r, pulled: ctx.now.toISOString() } satisfies Snapshot);
  ctx.log(`cash-check: bank summary to ${end}, ${r.rows.length} rows`);
  return { stored: end, rows: r.rows.length };
}

/** Daily: on a due day, draft the pack from the stored snapshots. The same period is overwritten, never added twice. */
export async function packBuild(ctx: Ctx<Settings>) {
  const { due, period } = periodFor(ctx.now, ctx.settings.cadence);
  if (!due) return { skipped: "period not due" };
  const pl = await ctx.store.get<Snapshot>("snapshots", period.key);
  if (!pl) return { skipped: "no profit and loss snapshot for this period yet" };
  const bank = await ctx.store.get<Snapshot>("bank", period.end);
  const html = packHtml(ctx.settings, period, pl, bank);
  await ctx.store.put("packs", period.key, { key: period.key, period, html, built: ctx.now.toISOString(), status: "draft" });
  ctx.log(`pack-build: draft pack ${period.key}`);
  return { drafted: period.key, bank: !!bank };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "data-pull": dataPull, "cash-check": cashCheck, "pack-build": packBuild };
