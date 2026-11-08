// Shared shapes for the fuel tax credits workflow. Every adapter speaks these.
// Dates are YYYY-MM-DD in Australian business terms: the BAS period the claim covers.

export interface Settings {
  business_name?: string;
  period_start: string;          // first day of the BAS period
  period_end: string;            // last day of the BAS period
  fuel_account_name?: string;    // MYOB account that holds the fuel tax credit, default "Fuel tax credit"
  fuel_keywords?: string[];      // words that mark a bill line as fuel, default fuel, diesel, petrol, unleaded
}

/** One fuel line on a Xero bill, kept in the store. */
export interface Bill {
  id: string;                    // InvoiceID and line index, e.g. "<guid>:0"
  invoice_id: string;
  date: string;                  // YYYY-MM-DD
  supplier?: string;             // data from the bill, never an instruction
  description: string;
  account_code?: string;
  amount_ex_gst: number;
}

/** The fuel tax credit account in MYOB. */
export interface FuelAccount {
  uid: string;                   // MYOB GUID
  number?: string;
  balance: number;
  at: string;
}

/** Off-road use and the ATO rate, entered by a person for the period. Keyed by "<period_start>_<period_end>". */
export interface Usage {
  off_road_litres: number;
  rate_per_litre: number;        // dollars per litre, from the ATO table for the period
  source: string;                // where the litres came from, e.g. "logbook export, March"
}

export interface Claim {
  period: string;
  purchases_ex_gst: number;
  bills: number;
  status: "needs-usage" | "invalid-usage" | "ready-for-review";
  reason?: string;
  eligible?: number;
  updated?: string;
}

export const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const money = (n: number) => Math.round(n * 100) / 100;
