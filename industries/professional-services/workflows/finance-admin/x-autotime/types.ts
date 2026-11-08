// Shared shapes for the automatic time capture workflow. Crons read, flag or queue. A time entry reaches Clio only
// after a person approves it, and a cron never writes one on its own.
export type Platform = "clio";

export interface Settings {
  business_name?: string;
  clio_user_id: number;                       // the fee earner whose time is captured (Clio user id)
  matter_status?: string;                     // matters to offer for classification (default "Open")
  default_activity_description_id?: number;   // optional Clio activity description for new entries
  default_non_billable?: boolean;             // billable unless a request says otherwise (default false)
}

/** A time entry as Clio holds it for the day. Hours come from quantity_in_hours (read side). */
export interface CapturedEntry { id: number; date: string; hours: number; note: string | null; matter_id: number | null; non_billable: boolean }

/** The running timer, if one is running. Clio returns 404 when none is. */
export interface RunningTimer { id: number; start_time: string | null; elapsed_seconds: number }

export interface Matter { id: number; display_number: string | null; description: string | null }

/** A time entry a person records in the workflow store (collection "requests"). Its id is set by the person. */
export interface Request {
  id: string; matter_id: number; date: string; hours: number; note?: string; billable?: boolean;
  status: "requested" | "queued" | "needs-check"; reason_parked?: string; requested_at: string;
}

export interface Flag { key: string; kind: "no-matter" | "no-note"; entry_id: number; date: string; raised: string }
