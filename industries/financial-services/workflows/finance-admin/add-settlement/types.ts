// Shapes for the settlement tracker. No platform is mapped for this job, so every record lives in the workflow store.

export interface Settings {
  business_name?: string;
  overdue_after_days?: number;     // days after the settlement date before a checklist counts as overdue
}

/** One loan on its way to settlement. Written into the store by a person or the agent until an intake adapter exists. */
export interface Settlement {
  id: string;                      // the business's file reference
  borrower: string;
  lender: string;
  settlement_date?: string;        // YYYY-MM-DD
  lender_confirmed: boolean;       // the lender has confirmed funding in writing
  file_notes: number;              // file notes on the file
  post_settlement_checks: boolean; // discharge, commission and trust checks are done
}

export interface Checklist {
  settlement: string;
  missing: string[];
  status: "ready" | "missing-items" | "overdue";
  checked: string;
}

const ID = /^[a-z0-9][a-z0-9:._-]{0,80}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, max = 120) => typeof v === "string" && v.length > 0 && v.length <= max;

/** Records come from outside the workflow, so every field is checked before a cron uses it. */
export function isValidSettlement(s: any): s is Settlement {
  return !!s && typeof s === "object" && ID.test(String(s.id ?? "")) && text(s.borrower) && text(s.lender)
    && (s.settlement_date === undefined || (typeof s.settlement_date === "string" && DATE.test(s.settlement_date) && !Number.isNaN(Date.parse(s.settlement_date))))
    && typeof s.lender_confirmed === "boolean"
    && Number.isInteger(s.file_notes) && s.file_notes >= 0 && s.file_notes <= 10000
    && typeof s.post_settlement_checks === "boolean";
}

export function checkSettlement(s: Settlement, now: Date, graceDays: number): Checklist {
  const missing: string[] = [];
  if (!s.settlement_date) missing.push("settlement date");
  if (!s.lender_confirmed) missing.push("lender confirmation");
  if (s.file_notes < 1) missing.push("file note");
  const past = !!s.settlement_date && Date.parse(s.settlement_date) + graceDays * 864e5 < now.getTime();
  if (past && !s.post_settlement_checks) missing.push("post-settlement checks");
  const status = past && !s.post_settlement_checks ? "overdue" : missing.length ? "missing-items" : "ready";
  return { settlement: s.id, missing, status, checked: now.toISOString() };
}
