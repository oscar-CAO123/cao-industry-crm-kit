// The investment maths workflow's two crons. Each is deterministic: it reads, works out the figures, and drafts a note.
// Nothing here sends. The judgment steps (comparables, tax, scenarios) belong to the agent skill in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import type { Analysis, Assumptions, Facts, Settings, Watch } from "./types.ts";
import { getProperty, addPropertyNote } from "./adapters/vaultre.ts";
import { priceEstimate } from "./adapters/domain.ts";

const WATCH_ID = /^[a-z0-9][a-z0-9-]{0,60}$/i;
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, name: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`assumption ${name} must be between ${min} and ${max}`);
  return n;
};

/** Gross yield and interest-only cash flow before tax, from one set of assumptions. Pure: no network. */
export function analyse(a: Assumptions): { gross_yield_pct: number; cash_flow_year: number } {
  const price = num(a.price, "price", 1, 1e9);
  const rent = num(a.weekly_rent, "weekly_rent", 0, 1e6) * 52;
  const costs = num(a.annual_costs, "annual_costs", 0, 1e7);
  const loan = a.loan_amount === undefined ? 0 : num(a.loan_amount, "loan_amount", 0, 1e9);
  const rate = a.loan_rate_pct === undefined ? 0 : num(a.loan_rate_pct, "loan_rate_pct", 0, 30);
  const interest = loan * rate / 100;
  return { gross_yield_pct: round2(rent / price * 100), cash_flow_year: round2(rent - costs - interest) };
}

const dollars = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-AU")}`;

function watches(ctx: Ctx<Settings>): Watch[] {
  return (ctx.settings.watchlist ?? []).map((w) => {
    if (!WATCH_ID.test(w.id)) throw new Error(`watch id ${JSON.stringify(w.id)} must be letters, digits and hyphens`);
    return w;
  });
}

/** Daily: read each watched property's record and its Domain price estimate, and keep the result for the note. */
export async function propertyFacts(ctx: Ctx<Settings>) {
  let read = 0;
  for (const w of watches(ctx)) {
    const facts: Facts = { watch: w.id, checked: ctx.now.toISOString(), vaultre_found: !!(await getProperty(ctx, w.vaultre_property_id)) };
    if (w.domain_property_id) facts.price_estimate = await priceEstimate(ctx, w.domain_property_id);
    await ctx.store.put("facts", w.id, facts);
    read++;
  }
  ctx.log(`property-facts: ${read} read`);
  return { read };
}

/** Every 30 minutes: work out the figures for each watch whose assumptions or facts changed, and draft one note on its property. */
export async function cashFlowNote(ctx: Ctx<Settings>) {
  let noted = 0, skipped = 0;
  for (const w of watches(ctx)) {
    const facts = await ctx.store.get<Facts>("facts", w.id);
    if (!facts) { skipped++; continue; }
    const hash = safeKey(JSON.stringify([w.assumptions, facts.checked]), 120);
    const prior = await ctx.store.get<Analysis>("analysis", w.id);
    if (prior?.input_hash === hash) { skipped++; continue; } // already noted from these inputs: a re-run never files it twice
    const { gross_yield_pct, cash_flow_year } = analyse(w.assumptions);
    const a = w.assumptions;
    const interest = (a.loan_amount ?? 0) * (a.loan_rate_pct ?? 0) / 100;
    const body = `Investment check ${ctx.now.toISOString().slice(0, 10)} for ${w.address}. Gross yield ${gross_yield_pct}% on a price of ${dollars(a.price)}. `
      + `Estimated cash flow before tax ${dollars(cash_flow_year)} a year: rent ${dollars(a.weekly_rent * 52)}, costs ${dollars(a.annual_costs)}, `
      + `interest ${dollars(interest)} on an interest-only loan. Figures use the assumptions in the workflow settings; check them before relying on them.`;
    await addPropertyNote(ctx, w.vaultre_property_id, body, ctx.settings.note_type_id);
    await ctx.store.put("analysis", w.id, { watch: w.id, input_hash: hash, gross_yield_pct, cash_flow_year, noted: ctx.now.toISOString() } satisfies Analysis);
    noted++;
  }
  ctx.log(`cash-flow-note: ${noted} drafted, ${skipped} unchanged or missing facts`);
  return { noted, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { propertyFacts, cashFlowNote };
