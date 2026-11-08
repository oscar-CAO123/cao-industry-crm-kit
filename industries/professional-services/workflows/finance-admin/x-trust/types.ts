// Shared shapes for the trust accounting workflow. Money held in trust is never moved by a cron: a requisition is queued.
export type Platform = "smokeball";

export interface Settings {
  business_name?: string;
  trust: Platform;
  trust_accounts: { id: string; name: string }[];   // the trust bank accounts in the practice system
  min_matter_balance?: number;                       // flag any matter whose trust balance falls below this (default 0)
  approver_user_id?: string;                         // empty: the platform's default approver
}

/** A disbursement a person records in the workflow store (collection "requests"). Its id is set by the person. */
export interface Request {
  id: string; account_id: string; matter_id: string; payee_id: string; amount: number;
  reference?: string; reason?: string; status: "requested" | "queued" | "needs-check"; reason_parked?: string; requested_at: string;
}
export interface MatterBalance { matter_id: string | null; balance: number; available: number }
export interface Transaction { id: string; type: string | null; amount: number; matter_id: string | null; entered: string | null }
export interface Flag { key: string; kind: "negative-matter-balance" | "unallocated-transaction"; account_id: string; matter_id?: string; transaction_id?: string; amount?: number; raised: string }
