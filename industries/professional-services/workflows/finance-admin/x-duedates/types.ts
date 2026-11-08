// Shared shapes for the due dates workflow. Crons read, draft an internal task in Xero Projects, or queue a chase email.
// A client email reaches Xero only after a person approves it, and a cron never sends one on its own.
export type Platform = "xero";

export interface Settings {
  business_name?: string;
  chase_after_days?: number;       // days overdue before a chase email is queued (default 7, 1 to 90)
  deadline_window_days?: number;   // project deadlines this close get a task drafted in Xero Projects (default 14, 1 to 60)
}

/** A sales invoice still owed money. days_overdue is negative while the invoice is not yet due. */
export interface Invoice { id: string; number: string; contact: string; due: string; amount_due: number; days_overdue: number }

/** An open Xero project. deadline is the project's deadlineUtc as YYYY-MM-DD, or null when none is set. */
export interface Project { id: string; name: string; deadline: string | null; status: string }
