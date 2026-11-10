// Shared shapes for the health-care budget burn workflow.

export interface Settings {
  business_name?: string;
  /** Window for the budget summary report. */
  timeframe?: "MONTH" | "QUARTER" | "YEAR";
}

export interface BudgetBalance { period: string; amount: number }
export interface BudgetLine { account_code: string; account_id?: string; balances: BudgetBalance[] }
export interface Budget { id: string; type: string; description: string; lines: BudgetLine[] }
export interface BurnRead { date: string; timeframe: string; report: unknown }

export const day = (d: Date) => d.toISOString().slice(0, 10);
