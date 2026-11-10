// Shared shapes for the billing narratives workflow. Crons read and draft. An invoice is authorised in Xero only after
// a person approves it, and no cron authorises one on its own.
export type Platform = "xero";

export const DAY = 864e5;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Xero id, checked before it goes into a path, a filter or a body. */
export const guid = (v: unknown): string => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("billing narratives: bad id"); return s; };
export const isGuid = (v: unknown): boolean => GUID.test(String(v ?? ""));

export interface Settings {
  business_name?: string;
  projects: string[];                 // Xero Projects ids, one per client whose time is narrated
  lookback_days?: number;             // how far back capture reads (default 31)
  payment_terms_days?: number;        // invoice due date, days after the draft (default 14)
  invoice_account_code?: string | null; // optional sales account code for each invoice line
}

/** A chargeable, uninvoiced time entry as stored. status: new (waiting to be narrated), drafted (on a draft invoice), gone (no longer ACTIVE in Xero). */
export interface Entry {
  id: string; project_id: string; task_id: string; date: string; minutes: number; description: string;
  status: "new" | "drafted" | "gone"; invoice?: string; seen: string;
}

/** The narrative a person or the agent writes for a client's entries (collection "proposals", keyed by project id). */
export interface ProposalLine { narrative: string; entry_ids: string[]; unit_amount?: number }
export interface Proposal { lines: ProposalLine[]; at: string }

export interface InvoiceRecord {
  id: string; project_id: string; entry_ids: string[]; total_ex_gst: number;
  status: "draft" | "authorised" | "voided"; approval: string; created: string;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** Narrative text: plain text on one line, 1 to 500 characters. Returns "" when it is not usable. */
export function cleanNarrative(s: unknown): string {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t.length >= 1 && t.length <= 500 ? t : "";
}
