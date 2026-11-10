// Xero for the BAS first pass. Reads the period's authorised bank transactions and the tax rates (draft operations),
// and queues one coding change per single-line transaction that an agreed rule matches. A coding change edits the
// books, so it is a live operation: an accountant approves it before Xero is touched.
import type { Check, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { GUID, PERIOD, CODABLE_TYPES, keyOf, type BankLine, type CodingRule, type Settings, type TaxRateRow } from "../types.ts";

const P = "xero";
const MAX_PAGES = 50;

/** The Xero where-filter, built from validated numbers only. Anything else in period_start is refused before a call. */
export function periodFilter(start: string): string {
  if (!PERIOD.test(String(start))) throw new Error("period_start must be YYYY-MM-DD");
  const [y, m, d] = start.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new Error("period_start is not a real date");
  const two = (n: number) => String(n).padStart(2, "0");
  return `Status=="AUTHORISED" AND Date>=DateTime(${y},${two(m)},${two(d)})`;
}

function toLine(t: any): BankLine | undefined {
  const id = String(t?.BankTransactionID ?? "");
  if (!GUID.test(id)) return undefined;
  const items: any[] = Array.isArray(t.LineItems) ? t.LineItems : [];
  const first = items[0] ?? {};
  const cid = String(t.Contact?.ContactID ?? "");
  return {
    id,
    type: String(t.Type ?? ""),
    date: String(t.Date ?? ""),
    contact: t.Contact?.Name ? String(t.Contact.Name).slice(0, 200) : undefined,
    contact_id: GUID.test(cid) ? cid : undefined,
    reference: t.Reference ? String(t.Reference).slice(0, 200) : undefined,
    description: first.Description ? String(first.Description).slice(0, 200) : undefined,
    amount: Number(first.LineAmount ?? t.Total),
    line_amount_types: t.LineAmountTypes ? String(t.LineAmountTypes) : undefined,
    line_count: items.length,
    account_code: first.AccountCode ? String(first.AccountCode) : undefined,
    tax_type: first.TaxType ? String(first.TaxType) : undefined,
    has_attachments: t.HasAttachments === true,
    reconciled: t.IsReconciled === true,
  };
}

/** Every authorised bank transaction dated in the period. Reads only. */
export async function bankLines(ctx: Ctx<Settings>): Promise<BankLine[]> {
  const where = periodFilter(ctx.settings.period_start);
  const out: BankLine[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getBankTransactions", summary: `bank transactions, page ${page}`,
      input: { params: { where, order: "Date ASC", page } } });
    const rows: any[] = Array.isArray(r.data?.BankTransactions) ? r.data.BankTransactions : [];
    for (const t of rows) { const l = toLine(t); if (l) out.push(l); }
    if (rows.length < 100) break;
  }
  return out;
}

/** The organisation's tax rates, for checking that a line's tax type still exists and is active. Reads only. */
export async function taxRates(ctx: Ctx<Settings>): Promise<TaxRateRow[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getTaxRates", summary: "tax rates" });
  const rows: any[] = Array.isArray(r.data?.TaxRates) ? r.data.TaxRates : [];
  return rows
    .filter((t) => /^[A-Z0-9_]{1,50}$/.test(String(t?.TaxType ?? "")))
    .map((t): TaxRateRow => ({ tax_type: String(t.TaxType), name: String(t.Name ?? t.TaxType).slice(0, 100), status: String(t.Status ?? "") }));
}

/** Queue the coding change for one line. The approval holds the exact body that will be sent. */
export async function queueCoding(ctx: Ctx<Settings>, line: BankLine, rule: CodingRule): Promise<string> {
  if (!GUID.test(line.id) || !CODABLE_TYPES.has(line.type) || line.line_count !== 1 || !Number.isFinite(line.amount)) {
    throw new Error(`xero: transaction ${line.id.slice(0, 8)} is not codable as one line`);
  }
  const tx: Record<string, unknown> = {
    BankTransactionID: line.id,
    Type: line.type,
    LineItems: [{ Description: line.description ?? line.reference ?? "Bank transaction", LineAmount: line.amount, AccountCode: rule.account_code, TaxType: rule.tax_type }],
  };
  if (line.line_amount_types) tx.LineAmountTypes = line.line_amount_types;
  if (line.contact_id) tx.Contact = { ContactID: line.contact_id };
  const label = `${line.contact ?? line.description ?? "transaction"} ${line.date.slice(0, 40)}`;
  // Approval re-reads the line and sends only if it is still the authorised, unreconciled line that was queued, with the
  // same type, amount and tax type. A line the accountant codes by hand is not caught: an uncoded line has no account code to compare.
  const expect: Check["expect"] = [
    { path: "BankTransactions.0.Status", equals: "AUTHORISED" },
    { path: "BankTransactions.0.IsReconciled", equals: false },
    { path: "BankTransactions.0.Type", equals: line.type },
    { path: "BankTransactions.0.LineItems.0.LineAmount", equals: line.amount },
  ];
  if (line.tax_type) expect.push({ path: "BankTransactions.0.LineItems.0.TaxType", equals: line.tax_type });
  return ctx.queue({
    platform: P, op: "accounting.updateBankTransaction", key: keyOf(`coding:${line.id}:${line.amount}:${line.tax_type ?? ""}`),
    summary: `code ${label} to account ${rule.account_code} (${rule.tax_type}) in Xero`,
    input: { params: { BankTransactionID: line.id }, body: { BankTransactions: [tx] } },
    check: { platform: P, op: "accounting.getBankTransaction", input: { params: { BankTransactionID: line.id } }, expect },
  },`Code ${label} to account ${rule.account_code} (${rule.tax_type}) in Xero, amount ${line.amount.toFixed(2)}`);
}
