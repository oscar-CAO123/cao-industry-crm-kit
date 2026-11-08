// The market-forecasting workflow's three crons. Each reads and drafts; none sends. The one email, the monthly
// forecast summary, is an Outlook draft that waits in the approval queue until a person sends it.
// Judgment (season, weather, what buyers said on the phone) stays with the owner, as SKILL.md describes.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import * as xero from "./adapters/xero.ts";
import * as m365 from "./adapters/microsoft-365.ts";
import {
  type Enquiry, type Item, type PriceCheck, type SaleLine, type Settings,
  EMAIL, alertAt, esc, keyOf, money, months, num, priorMonths, since, ym,
} from "./types.ts";

const DAY = 864e5;
const day = (d: Date) => d.toISOString().slice(0, 10);

/** The latest invoiced unit price per item (lower-cased code). */
function lastInvoiced(lines: SaleLine[]) {
  const out = new Map<string, { unit: number; date: string; name: string }>();
  for (const s of lines) {
    const k = s.code.toLowerCase(), cur = out.get(k);
    if (!cur || s.date > cur.date) out.set(k, { unit: s.unit, date: s.date, name: s.name });
  }
  return out;
}

/** Daily, early morning: sales invoices from Xero (12 months) and buyer enquiries from the mailbox, stored for the other crons. */
export async function demandSignal(ctx: Ctx<Settings>) {
  const lines = await xero.sales(ctx, since(ctx.now, 12));
  for (const l of lines) await ctx.store.put("sales", l.id, l);
  const mail = await m365.enquiries(ctx);
  for (const e of mail) await ctx.store.put("enquiries", e.id, e);
  ctx.log(`demand-signal: ${lines.length} sale lines, ${mail.length} enquiries`);
  return { sale_lines: lines.length, enquiries: mail.length };
}

/** Daily: compare each item's list price (the Excel price list when set, else Xero sales prices) with the last price invoiced.
 *  Every comparison is stored. A move past the alert level is logged to the register once per item per month. */
export async function priceWatch(ctx: Ctx<Settings>) {
  const last = lastInvoiced(Object.values(await ctx.store.list<SaleLine>("sales")));
  const table = ctx.settings.microsoft_365?.price_table;
  const list: Item[] = table ? await m365.priceTable(ctx, table) : await xero.items(ctx);
  const at = ctx.now.toISOString(), month = ym(ctx.now), alert = alertAt(ctx.settings);
  const rows: unknown[][] = [], logKeys: string[] = [];
  let checked = 0;
  for (const it of list) {
    const l = last.get(it.code.toLowerCase());
    if (!l || !(l.unit > 0)) continue;
    const pct = num(((it.price - l.unit) / l.unit) * 100);
    const check: PriceCheck = { code: it.code, name: it.name, last: l.unit, list: it.price, pct, checked: at };
    await ctx.store.put("prices", keyOf(it.code), check);
    checked++;
    const k = keyOf(`${month}:${it.code}`);
    if (Math.abs(pct) >= alert && !(await ctx.store.get("price-log", k))) {
      rows.push([day(ctx.now), it.code, it.name, l.unit, it.price, pct, "list price differs from last invoiced"]);
      logKeys.push(k);
    }
  }
  const reg = ctx.settings.microsoft_365?.register;
  if (rows.length && reg) {
    await m365.appendRows(ctx, reg, rows, `log ${rows.length} price moves`);
    for (const k of logKeys) await ctx.store.put("price-log", k, { at });
  }
  ctx.log(`price-watch: ${checked} items checked, ${rows.length} price moves logged`);
  return { checked, logged: rows.length };
}

/** Monthly (the 1st, early morning): expected volume per item from the trailing average, one register row per item
 *  for the month, and one summary email to the owner as a draft whose send waits for approval. */
export async function forecast(ctx: Ctx<Settings>) {
  const n = months(ctx.settings), basis = new Set(priorMonths(ctx.now, n)), target = ym(ctx.now), at = ctx.now.toISOString();
  const sales = Object.values(await ctx.store.list<SaleLine>("sales"));
  const vol = new Map<string, { code: string; name: string; qty: number }>();
  for (const s of sales) {
    if (!basis.has(s.date.slice(0, 7))) continue;
    const k = s.code.toLowerCase(), v = vol.get(k) ?? { code: s.code, name: s.name, qty: 0 };
    v.qty += s.qty;
    vol.set(k, v);
  }
  const last = lastInvoiced(sales);
  const rows = [...vol.values()].sort((a, b) => b.qty - a.qty)
    .map((v) => ({ code: v.code, name: v.name, expected: num(v.qty / n), last: last.get(v.code.toLowerCase())?.unit }));
  if (!rows.length) {
    ctx.log("forecast: no sales in the basis months, nothing to forecast");
    return { forecast_rows: 0, drafted: false };
  }
  const alert = alertAt(ctx.settings);
  const flags = Object.values(await ctx.store.list<PriceCheck>("prices")).filter((p) => Math.abs(p.pct) >= alert);

  const reg = ctx.settings.microsoft_365?.register;
  const fresh: typeof rows = [];
  for (const r of rows) if (!(await ctx.store.get("forecast-log", keyOf(`${target}:${r.code}`)))) fresh.push(r);
  if (fresh.length) {
    if (reg) await m365.appendRows(ctx, reg, fresh.map((r) => [day(ctx.now), r.code, r.name, r.expected, r.last ?? "", `forecast for ${target}`]), `log ${fresh.length} forecast rows`);
    for (const r of fresh) await ctx.store.put("forecast-log", keyOf(`${target}:${r.code}`), { at });
  }

  const summaryKey = keyOf(`summary:${target}`);
  if (await ctx.store.get("forecast-log", summaryKey)) return { forecast_rows: rows.length, drafted: false };
  const to = ctx.settings.summary_to;
  if (!EMAIL.test(to ?? "")) throw new Error("summary_to is not a valid address");
  const cutoff = ctx.now.getTime() - 31 * DAY;
  const enquiries = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => Date.parse(e.received) >= cutoff).length;
  const d = await m365.mailDraft(ctx, to, `${ctx.settings.business_name ?? "Forecast"}: forecast for ${target}`, summaryHtml(ctx.settings, target, n, rows, flags, enquiries));
  await ctx.queue({ ...d.send, key: `forecast:${target}` }, `send the ${target} forecast summary to ${to}`);
  await ctx.store.put("forecast-log", summaryKey, { at, message: d.messageId });
  ctx.log(`forecast: ${rows.length} items, summary drafted for ${to}`);
  return { forecast_rows: rows.length, drafted: true, price_moves: flags.length };
}

/** The summary as escaped HTML: expected volume per item, price moves past the alert level, and recent enquiries. */
export function summaryHtml(s: Settings, target: string, n: number,
  rows: { name: string; expected: number; last?: number }[], flags: PriceCheck[], enquiries: number): string {
  const body = rows.slice(0, 40).map((r) => `<tr><td>${esc(r.name)}</td><td align="right">${esc(r.expected)}</td><td align="right">${r.last === undefined ? "" : esc(money(r.last))}</td></tr>`).join("");
  const more = rows.length > 40 ? `<p>${esc(rows.length - 40)} more items are in the register.</p>` : "";
  const moves = [...flags].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 10)
    .map((p) => `<li>${esc(p.name)}: list ${esc(money(p.list))}, last invoiced ${esc(money(p.last))} (${esc(p.pct)}%)</li>`).join("");
  return `<p>Forecast for ${esc(target)}, from the average invoiced volume over the last ${esc(n)} complete months.</p>`
    + `<table cellpadding="4"><tr><th align="left">Item</th><th align="right">Expected qty</th><th align="right">Last invoiced price</th></tr>${body}</table>${more}`
    + (moves ? `<p>Price moves to check:</p><ul>${moves}</ul>` : "<p>No price moves past the alert level.</p>")
    + `<p>Buyer enquiries in the last 31 days: ${esc(enquiries)}.</p>`
    + "<p>The expected quantities are a trailing average of what was invoiced. Check them against the season, the weather and what buyers have said before you commit stock.</p>";
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "demand-signal": demandSignal,
  "price-watch": priceWatch,
  forecast,
};
