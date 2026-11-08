// The BAS first-pass crons. Each reads, drafts or queues; none sends, lodges or posts to a ledger on its own.
// Judgment (the account a new kind of payment belongs to, whether a line is GST-free, the BAS itself) stays with the
// accountant, as described in SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { bankLines, taxRates, queueCoding } from "./adapters/xero.ts";
import { CODABLE_TYPES, checkRule, type BankLine, type CodingRule, type Exception, type Settings, type Snapshot, type TaxRateRow } from "./types.ts";

const activeTypes = (rates: TaxRateRow[]) => new Set(rates.filter((r) => r.status === "ACTIVE").map((r) => r.tax_type));
const rulesOf = (s: Settings): CodingRule[] => (s.coding_rules ?? []).map(checkRule);
const hayOf = (l: BankLine) => `${l.contact ?? ""} ${l.reference ?? ""} ${l.description ?? ""}`.toLowerCase();
const ruleFor = (l: BankLine, rules: CodingRule[]) => rules.find((r) => hayOf(l).includes(r.match.toLowerCase()));

/** Daily: read the period's authorised bank transactions and the tax rates, and keep them for the other crons. Reads only. */
export async function pullPeriod(ctx: Ctx<Settings>) {
  const lines = await bankLines(ctx);
  const rates = await taxRates(ctx);
  const snap: Snapshot = { period: ctx.settings.period_start, pulled: ctx.now.toISOString(), lines, rates };
  await ctx.store.put("bas", ctx.settings.period_start, snap);
  const uncoded = lines.filter((l) => !l.account_code).length;
  ctx.log(`pull-period: ${lines.length} transactions, ${uncoded} uncoded, ${rates.length} tax rates`);
  return { transactions: lines.length, uncoded };
}

/** Daily: queue a coding change for each single-line, uncoded, unreconciled transaction that an agreed rule matches. */
export async function codeLines(ctx: Ctx<Settings>) {
  const snap = await ctx.store.get<Snapshot>("bas", ctx.settings.period_start);
  if (!snap) return { queued: 0, note: "pull-period has not run for this period" };
  const rules = rulesOf(ctx.settings);
  const live = activeTypes(snap.rates);
  let queued = 0;
  for (const l of snap.lines) {
    if (l.account_code || l.reconciled || l.line_count !== 1 || !CODABLE_TYPES.has(l.type) || !Number.isFinite(l.amount)) continue;
    const rule = ruleFor(l, rules);
    if (!rule || !live.has(rule.tax_type)) continue;
    await queueCoding(ctx, l, rule);
    queued++;
  }
  ctx.log(`code-lines: ${queued} coding changes queued or already waiting`);
  return { queued };
}

/** Daily: list what the accountant must check by hand before the BAS. Writes an internal list only. */
export async function exceptions(ctx: Ctx<Settings>) {
  const snap = await ctx.store.get<Snapshot>("bas", ctx.settings.period_start);
  if (!snap) return { exceptions: 0, note: "pull-period has not run for this period" };
  const rules = rulesOf(ctx.settings);
  const live = activeTypes(snap.rates);
  const items: Exception[] = [];
  for (const l of snap.lines) {
    const reasons: string[] = [];
    if (l.line_count !== 1) reasons.push("more than one line: code it by hand");
    if (!l.account_code && !ruleFor(l, rules)) reasons.push("uncoded, and no coding rule matches");
    if (l.tax_type && !live.has(l.tax_type)) reasons.push(`tax type ${l.tax_type} is not active in Xero`);
    if (!l.has_attachments) reasons.push("no source document attached");
    if (reasons.length) items.push({ id: l.id, reason: reasons.join("; "), description: l.contact ?? l.description, amount: l.amount });
  }
  await ctx.store.put("bas-exceptions", ctx.settings.period_start, { period: ctx.settings.period_start, drafted: ctx.now.toISOString(), items });
  ctx.log(`exceptions: ${items.length} to check by hand`);
  return { exceptions: items.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "pull-period": pullPeriod,
  "code-lines": codeLines,
  exceptions,
};
