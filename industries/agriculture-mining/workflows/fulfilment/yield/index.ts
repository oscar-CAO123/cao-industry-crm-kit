// The yield-and-waste workflow's three crons. Each reads, drafts or queues; none sends. The weekly report email is drafted
// in the shed's mailbox and queued for a person to approve, like every other message this kit sends.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Lot, type Exception, type Report, EMAIL, esc, keyOf, pct, weekStart } from "./types.ts";
import { readRegister, writeException, mailDraft, sendAct } from "./adapters/microsoft-365.ts";

const DAY = 864e5;

/** Every 30 minutes: read the yield register and store each lot. A lot is updated on each run, never stored twice. */
export async function intake(ctx: Ctx<Settings>) {
  const { lots, rejected } = await readRegister(ctx);
  let added = 0;
  for (const l of lots) {
    const key = keyOf(`lot:${l.lot}`);
    const prev = await ctx.store.get<Lot>("lots", key);
    if (!prev) added++;
    await ctx.store.put("lots", key, { ...l, seen: prev?.seen ?? ctx.now.toISOString() } satisfies Lot);
  }
  if (rejected) ctx.log(`intake: ${rejected} rows refused (no lot code, weights not numbers, or packed plus waste over gross)`);
  ctx.log(`intake: ${added} new lots, ${lots.length} read`);
  return { added, read: lots.length, rejected };
}

/** Every hour: work out yield and waste per lot. A lot under target or over the waste limit gets one exception row, once. */
export async function yieldCheck(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const lots = Object.values(await ctx.store.list<Lot>("lots"));
  let raised = 0, written = 0;
  for (const l of lots) {
    const y = pct(l.packed_kg, l.gross_kg), w = pct(l.waste_kg, l.gross_kg);
    const reasons: string[] = [];
    if (y < s.expected_yield_pct) reasons.push(`yield ${y}% is under the ${s.expected_yield_pct}% target`);
    if (w > s.waste_alert_pct) reasons.push(`waste ${w}% is over the ${s.waste_alert_pct}% limit`);
    if (!reasons.length) continue;
    const key = keyOf(`exception:${l.lot}`);
    if (await ctx.store.get("exceptions", key)) continue;   // one exception per lot, however many runs see it
    const x: Exception = { lot: l.lot, date: l.date, yield_pct: y, waste_pct: w, reasons, raised: ctx.now.toISOString() };
    if (await writeException(ctx, x)) written++;
    await ctx.store.put("exceptions", key, x);
    raised++;
  }
  ctx.log(`yield-check: ${raised} exceptions raised (${written} written to the exceptions table) across ${lots.length} lots`);
  return { raised, written, checked: lots.length };
}

/** Sunday 22:00 UTC (Monday morning in eastern Australia): draft this week's report and queue its email for approval. */
export async function ownerReport(ctx: Ctx<Settings>) {
  const s = ctx.settings;
  const week = weekStart(ctx.now);
  if (await ctx.store.get<Report>("reports", week)) return { queued: 0, week };   // this week's report is already drafted and queued
  if (!EMAIL.test(s.owner_email)) throw new Error("owner_email is not set");

  const start = Date.parse(week), end = start + 7 * DAY;
  const all = Object.values(await ctx.store.list<Lot>("lots"));
  const inWeek = all.filter((l) => { const t = Date.parse(l.date); return Number.isFinite(t) && t >= start && t < end; });
  const undated = all.filter((l) => !l.date).length;
  if (undated) ctx.log(`owner-report: ${undated} lots have no usable date and are left out`);
  const ids = new Set(inWeek.map((l) => l.lot));
  const shortfall = Object.values(await ctx.store.list<Exception>("exceptions"))
    .filter((x) => ids.has(x.lot)).map((x) => `${x.lot}: ${x.reasons.join("; ")}`);

  const gross = inWeek.reduce((a, l) => a + l.gross_kg, 0), packed = inWeek.reduce((a, l) => a + l.packed_kg, 0);
  const waste = inWeek.reduce((a, l) => a + l.waste_kg, 0);
  const yieldPct = pct(packed, gross), wastePct = pct(waste, gross);
  const rows = inWeek.map((l) => `<tr><td>${esc(l.lot)}</td><td>${esc(l.area)}</td><td align="right">${esc(l.gross_kg)}</td>`
    + `<td align="right">${esc(l.packed_kg)}</td><td align="right">${esc(l.waste_kg)}</td>`
    + `<td align="right">${pct(l.packed_kg, l.gross_kg)}%</td><td align="right">${pct(l.waste_kg, l.gross_kg)}%</td></tr>`).join("");
  const html = `<p>Yield and waste for the week of ${esc(week)}: ${inWeek.length} lots, ${esc(gross)} kg in, ${esc(packed)} kg packed, `
    + `${esc(waste)} kg waste (${esc(yieldPct)}% yield, ${esc(wastePct)}% waste).</p>`
    + (shortfall.length ? `<p>Lots to look at:</p><ul>${shortfall.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p>No lot fell short this week.</p>`)
    + `<table cellpadding="4"><tr><th align="left">Lot</th><th align="left">Area</th><th>Gross kg</th><th>Packed kg</th><th>Waste kg</th>`
    + `<th>Yield</th><th>Waste</th></tr>${rows}</table>`;

  const messageId = await mailDraft(ctx, s.owner_email, `Yield and waste, week of ${week}`, html);
  await ctx.queue({ ...sendAct(ctx, messageId, `report:${week}`) },
    `Send yield and waste report for the week of ${week} to ${s.owner_email}: ${inWeek.length} lots, ${yieldPct}% yield, ${wastePct}% waste`);
  await ctx.store.put("reports", week, { week, lots: inWeek.length, gross_kg: gross, packed_kg: packed, waste_kg: waste,
    yield_pct: yieldPct, waste_pct: wastePct, shortfall, html, message_id: messageId, queued: ctx.now.toISOString() } satisfies Report);
  return { queued: 1, week, lots: inWeek.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, "yield-check": yieldCheck, "owner-report": ownerReport };
