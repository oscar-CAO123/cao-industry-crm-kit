// Shared shapes for the defects workflow. Two platforms: ServiceM8 (a job's defect checklist section is the register's source) or Procore (the project's punch list). A business sets one.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "servicem8" | "procore";

export interface TradeContact { match: string; name: string; email: string }
export interface Settings {
  family: "defects-on-jobs";
  business_name?: string;
  defect_section?: string;         // ServiceM8: the checklist section on a job that holds its defects (not used with procore)
  first_reminder_after_days?: number;
  reminder_every_days?: number;
  trade_contacts?: TradeContact[]; // ServiceM8: who chases a defect: matched by a word in the defect's name
  /** Set this block instead of defect_section; both together are refused. Project ids are Procore's integers as digit strings. */
  procore?: { projects: { id: string; name: string }[] };
}

/** One defect: a checklist item in the defect section of a job. Kept in the store under the checklist item's uuid. */
export interface Defect {
  id: string;                      // the checklist item uuid
  job_uuid: string;
  company_uuid?: string;           // the client's company on the job, for the sign-off email
  address: string;
  name: string;
  status: "open" | "fixed" | "withdrawn";
  logged: string;                  // ISO time the cron first saw it
  task_ref?: string;               // the ServiceM8 task created for it, once created
  fixed_at?: string;
  reminders: string[];             // ISO times reminders were queued
}

/** One job that has defects: its close-out state, kept in the store under the job uuid. */
export interface JobCloseOut { job_uuid: string; task_ref?: string; client_notified?: string }

export interface Adapter {
  id: Platform;
  /** Jobs whose defects are being tracked (status Work Order). */
  openJobs?(ctx: Ctx<Settings>): Promise<{ uuid: string; address: string; company_uuid?: string }[]>;
  /** Items in the defect section of a job, with completion state. */
  defectItems?(ctx: Ctx<Settings>, jobUuid: string): Promise<{ uuid: string; name: string; active: boolean; completed_at?: string }[]>;
  /** A task on the job for staff (draft operation). Returns the record id. */
  createTask?(ctx: Ctx<Settings>, jobUuid: string, title: string, details: string): Promise<string | undefined>;
  /** The client's contact on a job's company. */
  clientContact?(ctx: Ctx<Settings>, companyUuid?: string): Promise<{ name?: string; email?: string }>;
  /** Queue an email for approval. Returns the approval id. */
  queueEmail?(ctx: Ctx<Settings>, a: { to: string; subject: string; html: string; key: string; summary: string; jobUuid: string }): Promise<string>;
}

export const DAY = 864e5;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
