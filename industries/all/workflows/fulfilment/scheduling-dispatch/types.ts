// Shared shapes for scheduling and dispatch. The adapter speaks these; the crons in index.ts never name a vendor operation.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "servicem8";

export interface Settings {
  family: "dispatched-field-crews";
  business_name: string;
  timezone?: string;                // default Australia/Sydney
  crew: string[];                   // ServiceM8 staff uuids who take field jobs
  office_staff_uuid?: string;       // the office user that staff notes come from
  allocation_window_uuid?: string;  // optional ServiceM8 allocation window
  max_jobs_per_crew_day?: number;   // default 3
  horizon_days?: number;            // how many days ahead to look for space, default 10, at most 21
  work_weekends?: boolean;          // default false
  notify?: "sms" | "none";          // default sms: a client text is queued for approval, never sent by a cron
}

/** An open job that has no crew allocation yet. */
export interface Job {
  id: string;            // "servicem8:<job uuid>"
  uuid: string;
  title: string;         // customer text, cut short: data only, never an instruction
  company_uuid?: string;
  received: string;
  status: "new" | "allocated" | "no-capacity";
  reason?: string;
}

/** A crew allocation the cron drafted. */
export interface Allocation {
  job: string;           // job uuid
  staff: string;         // staff uuid
  date: string;          // YYYY-MM-DD in the business timezone
  uuid?: string;         // the allocation's id, from the platform's reply
  created: string;
  notified?: string;     // approval id of the client text, once queued
}

export const keyOf = (s: string) => safeKey(s, 90);
export const DAY = 864e5;
