// Shared shapes for the missed rebates workflow. Reads only; the flag list is this workflow's own register.

export type Platform = "cliniko" | "xero";

export interface Settings {
  business_name?: string;
  rebate_codes: string[];       // the item codes this clinic uses for rebate-eligible services
  review_after_days?: number;   // how long an open rebate invoice may sit before it is listed (default 14)
}

/** One Cliniko invoice, kept to what the finder needs: no patient names or contact details. */
export interface InvoiceRow {
  key: string;        // cliniko:<invoice id>
  id: string;
  number: number;
  status: number;     // Cliniko: 10 Open, 20 Paid, 30 Closed, 40 Open credit
  total_amount: string;
  created_at: string;
  codes: string[];    // item codes on the invoice
}

/** One Xero payment, matched back to an invoice number. */
export interface PaymentRow { invoice_number: string; amount: number; date: string; status: string }

/** A row in the register a person checks. */
export interface Flag {
  key: string; invoice: string; number: number; codes: string[]; total_amount: string; created_at: string;
  reason: string; status: "to-check";
}
