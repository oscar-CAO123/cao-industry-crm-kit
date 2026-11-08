// Shared shapes for the WIP and retention workflow. Xero holds the invoices, so one adapter covers every step that touches a platform.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "xero";

export interface Job {
  id: string;                 // a short key, e.g. the job number
  name: string;               // what the client sees on the claim
  contact_id: string;         // the client's Xero ContactID (a GUID)
  contract_value: number;     // ex GST, from the signed contract and accepted variations
  percent_complete: number;   // 0 to 100, from the owner or the site report
  claim_every_days?: number;  // how often a progress claim may go out, default 30
  retention_percent?: number; // held back from each claim and recorded, default 0
}

export interface Settings {
  business_name?: string;
  gst_rate?: number;          // default 0.1
  due_days?: number;          // due date on a progress claim, default 14
  chase?: { after_days: number[] }; // days past due for each reminder, default [7, 21]
  jobs: Job[];
}

export interface Snapshot {
  job: string; name: string; contract_value: number; percent_complete: number;
  earned: number; billed: number; over_under: number; invoices: number;
}
export interface Claim {
  job: string; claim_no: number; billed_to_date: number; this_claim: number; retention_held: number;
  claimed_at: string; invoice_id: string;
}
export interface Chase { invoice_id: string; reminders: number; last_queued: string }

export const DAY = 864e5;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_ID = /^[a-z0-9][a-z0-9:._-]{0,60}$/i;
export const isGuid = (v: unknown) => typeof v === "string" && GUID.test(v);
export const guid = (v: unknown) => { if (!isGuid(v)) throw new Error("xero: bad id"); return String(v); };
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const keyOf = (s: string) => safeKey(s, 120);

/** Check a job from settings before any call uses it. Throws on a bad value, so the cron skips that job and logs why. */
export function checkJob(j: Job): Job {
  if (!j || typeof j.id !== "string" || !JOB_ID.test(j.id)) throw new Error(`bad job id`);
  if (typeof j.name !== "string" || !j.name.trim() || j.name.length > 200) throw new Error(`${j.id}: bad name`);
  if (!isGuid(j.contact_id)) throw new Error(`${j.id}: contact_id is not a Xero ContactID`);
  if (!Number.isFinite(j.contract_value) || j.contract_value < 0 || j.contract_value > 1e9) throw new Error(`${j.id}: bad contract_value`);
  if (!Number.isFinite(j.percent_complete) || j.percent_complete < 0 || j.percent_complete > 100) throw new Error(`${j.id}: percent_complete must be 0 to 100`);
  const every = j.claim_every_days ?? 30;
  if (!Number.isInteger(every) || every < 1 || every > 366) throw new Error(`${j.id}: bad claim_every_days`);
  const ret = j.retention_percent ?? 0;
  if (!Number.isFinite(ret) || ret < 0 || ret > 100) throw new Error(`${j.id}: bad retention_percent`);
  return j;
}
