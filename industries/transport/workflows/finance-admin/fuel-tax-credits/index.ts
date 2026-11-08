// The fuel tax credits workflow's three crons. Each reads and drafts into the workflow's own store.
// No cron writes to Xero or MYOB, and no live operation is mapped yet, so nothing can be queued for approval.
// Judgment (off-road litres, the ATO rate) is entered by a person as a usage record in the store.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Bill, Claim, Settings, Usage } from "./types.ts";
import { DAY, money } from "./types.ts";
import { fuelBills } from "./adapters/xero.ts";
import { fuelAccount } from "./adapters/myob.ts";

/** Daily: keep the fuel bills in the BAS period. A re-run overwrites the same lines, so it never duplicates. */
export async function purchases(ctx: Ctx<Settings>) {
  const { bills, pageFull } = await fuelBills(ctx);
  if (pageFull) ctx.log("purchases: 100 bills read, the first page is full; paging is not built, totals may be short");
  for (const b of bills) await ctx.store.put("fuel-bills", b.id, b);
  ctx.log(`purchases: ${bills.length} fuel lines kept`);
  return { found: bills.length, page_full: pageFull };
}

/** Daily: keep the fuel tax credit account uid and balance from MYOB. */
export async function ledger(ctx: Ctx<Settings>) {
  const a = await fuelAccount(ctx);
  if (!a) { ctx.log(`ledger: no account named "${ctx.settings.fuel_account_name ?? "Fuel tax credit"}"`); return { found: false }; }
  await ctx.store.put("fuel-account", "fuel-tax-credit", a);
  ctx.log(`ledger: fuel tax credit balance ${money(a.balance)}`);
  return { found: true, balance: a.balance };
}

/** Weekly: draft the claim worksheet for the period. Eligible amount needs the usage record; without it the claim waits. */
export async function claim(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  if (!DAY.test(s.period_start) || !DAY.test(s.period_end)) throw new Error("fuel-tax-credits: period dates must be YYYY-MM-DD");
  const key = `${s.period_start}_${s.period_end}`;
  const bills = Object.values(await ctx.store.list<Bill>("fuel-bills"))
    .filter((b) => b.date >= s.period_start && b.date <= s.period_end);
  const purchases_ex_gst = money(bills.reduce((a, b) => a + b.amount_ex_gst, 0));
  const usage = await ctx.store.get<Usage>("usage", key);
  const base = { period: key, purchases_ex_gst, bills: bills.length };
  let out: Claim;
  if (!usage) {
    out = { ...base, status: "needs-usage", reason: "no off-road litres or ATO rate recorded for this period" };
  } else {
    const litres = Number(usage.off_road_litres), rate = Number(usage.rate_per_litre);
    const ok = Number.isFinite(litres) && litres >= 0 && litres <= 10_000_000 && Number.isFinite(rate) && rate >= 0 && rate <= 10;
    out = ok
      ? { ...base, status: "ready-for-review", eligible: money(litres * rate), reason: `${usage.source}`.slice(0, 200) }
      : { ...base, status: "invalid-usage", reason: "off-road litres or rate is out of range" };
  }
  await ctx.store.put("claims", key, { ...out, updated: ctx.now.toISOString() });
  ctx.log(`claim: ${key} ${out.status}`);
  return out;
}

export const CRONS = { purchases, ledger, claim };
