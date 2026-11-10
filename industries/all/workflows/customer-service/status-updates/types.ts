// Shared shapes for the status-updates workflow. The ServiceM8 adapter speaks these; crons read, draft and queue.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Status = "Quote" | "Work Order" | "Completed" | "Unsuccessful";
export type Channel = "sms" | "email";

export interface Settings {
  business_name?: string;
  /** How customers hear about progress. When the preferred route is missing, the other one is used. */
  channel: Channel;
  /** Statuses that message the customer. Unsuccessful is never listed here: a person writes that message. */
  notify_statuses: ("Work Order" | "Completed")[];
  /** Digest only: a work order whose work_order_date is older than this many days is listed for the office. */
  stale_after_days?: number;
}

export interface Job { uuid: string; status: Status; job_address?: string; company_uuid?: string; work_order_date?: string }
export interface Contact { name?: string; email?: string; phone?: string }
export interface Seen { status: Status; seen: string }
export interface Change {
  key: string; job: Job; from: Status; to: Status; detected: string;
  state: "new" | "queued" | "needs-contact" | "human";
  channel?: Channel; approval?: string; note?: string;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE = /^\+[1-9]\d{6,14}$/;
export const STATUSES: Status[] = ["Quote", "Work Order", "Completed", "Unsuccessful"];
export const keyOf = (s: string) => safeKey(s, 90);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** What the customer is told for each status that messages them. Plain words, and no promise the office has not made. */
export const UPDATE: Record<"Work Order" | "Completed", string> = {
  "Work Order": "your job is booked in with us, and we will be in touch to confirm the arrival time.",
  "Completed": "your job is now complete. If you have any questions about the work, reply to this message.",
};
