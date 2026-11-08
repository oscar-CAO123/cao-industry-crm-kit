// Shared shapes for the investment maths workflow. Figures are whole dollars and percentages to two decimals.

export interface Assumptions {
  price: number;            // purchase price
  weekly_rent: number;      // expected rent per week
  annual_costs: number;     // rates, insurance, management, maintenance, per year
  loan_amount?: number;     // interest-only loan
  loan_rate_pct?: number;   // loan interest rate, per year
}

export interface Watch {
  id: string;               // short key, safe for the store
  address: string;
  vaultre_property_id: number;
  domain_property_id?: string;
  assumptions: Assumptions;
}

export interface Settings {
  business_name?: string;
  note_type_id: number;     // the VaultRE property note type to file the result under
  watchlist: Watch[];
}

export interface Facts {
  watch: string;
  checked: string;
  vaultre_found?: boolean;
  price_estimate?: unknown;  // stored as the vendor returned it
}

export interface Analysis {
  watch: string;
  input_hash: string;        // the assumptions and facts the note was written from
  gross_yield_pct: number;
  cash_flow_year: number;
  noted?: string;
}
