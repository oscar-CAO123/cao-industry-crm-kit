// Shared shapes for the cost of production workflow. Costs come from the books; the workflow only reads them.
export type Platform = "xero";

export interface Settings {
  business_name?: string;
  books: Platform;                   // where the ledger lives
  season_start: string;              // ISO date, e.g. 2026-07-01
  cost_types: string[];              // Xero account types that count as cost of production
  budget_id?: string;                // Xero budget GUID for the season, optional
  volume?: { unit: string; quantity: number }; // what the cost is spread over, e.g. hectares or head
}

export interface Account { code: string; name: string }
export interface CostLine { name: string; amount: number }
export interface CostSummary {
  season_start: string; as_at: string; lines: CostLine[]; total: number;
  unit?: string; quantity?: number; cost_per_unit?: number;
}
export interface Variance { name: string; actual: number; budget: number; variance: number }

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const round2 = (n: number) => Math.round(n * 100) / 100;
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
