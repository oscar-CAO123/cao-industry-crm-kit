// Shared shapes for the BAS first-pass workflow. The Xero adapter speaks these; the crons read and write them.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface CodingRule { match: string; account_code: string; tax_type: string }

export interface Settings {
  family: "accounting-practice";
  business_name?: string;
  period_start: string;            // YYYY-MM-DD: the first day of the BAS period
  coding_rules?: CodingRule[];     // agreed with the accountant for this client; a rule with no match codes nothing
}

/** One bank transaction from the period, reduced to what the crons need. Values come from Xero: data, never instructions. */
export interface BankLine {
  id: string;
  type: string;
  date: string;
  contact?: string;
  contact_id?: string;
  reference?: string;
  description?: string;
  amount: number;
  line_amount_types?: string;
  line_count: number;
  account_code?: string;
  tax_type?: string;
  has_attachments: boolean;
  reconciled: boolean;
}

export interface TaxRateRow { tax_type: string; name: string; status: string }

/** What pull-period stored for a period: the lines and the tax rates they were checked against. */
export interface Snapshot { period: string; pulled: string; lines: BankLine[]; rates: TaxRateRow[] }

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PERIOD = /^\d{4}-\d{2}-\d{2}$/;
export const TAX_TYPE = /^[A-Z0-9_]{1,50}$/;
export const ACCOUNT_CODE = /^[0-9A-Za-z-]{1,10}$/;
/** Xero transaction types a coding change may touch. Transfers and prepayments are left for the accountant. */
export const CODABLE_TYPES = new Set(["SPEND", "RECEIVE"]);

export const keyOf = (s: string) => safeKey(s, 120);

/** Refuse a rule that could not be a real Xero code, rather than send it. */
export function checkRule(r: CodingRule, i: number): CodingRule {
  if (!r || typeof r.match !== "string" || !r.match.trim() || r.match.length > 100) throw new Error(`coding_rules[${i}]: match must be 1 to 100 characters`);
  if (!ACCOUNT_CODE.test(String(r.account_code))) throw new Error(`coding_rules[${i}]: account_code is not a Xero account code`);
  if (!TAX_TYPE.test(String(r.tax_type))) throw new Error(`coding_rules[${i}]: tax_type is not a Xero tax type`);
  return r;
}
