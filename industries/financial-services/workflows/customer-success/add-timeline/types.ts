// Shared shapes for the client timeline workflow. Every id that goes into a path or a store key is checked here first.
export type Platform = "gohighlevel";

export interface Settings {
  business_name?: string;
  platform: Platform;
  gohighlevel: { owner_user_id: string };
  watch: { contact_id: string; opportunity_id?: string }[];
  check_in_days?: number;
}

/** A note as GoHighLevel returns it from GET /contacts/{contactId}/notes. */
export interface Note { id: string; body?: string; dateAdded?: string; userId?: string }
/** A task as GoHighLevel returns it from GET /contacts/{contactId}/tasks. */
export interface Task { id: string; title?: string; body?: string; dueDate?: string; completed?: boolean; assignedTo?: string }

export interface TimelineEvent { at: string; kind: "note" | "task"; id: string; text: string; by?: string }
export interface Timeline { contact_id: string; events: TimelineEvent[]; last_activity: string | null; updated: string }

/** A hand-off, written to the "handoffs" store by the CRM shell form. */
export interface Handoff {
  id: string; contact_id: string; opportunity_id?: string; to_user_id: string; summary: string;
  status_change?: "open" | "won" | "lost" | "abandoned"; lost_reason_id?: string;
  status: "new" | "drafted" | "needs-check"; done?: string[]; created: string;
}
export interface CheckIn { contact_id: string; task_at: string }

/** Ids are GoHighLevel's 20-character style ids. Anything else is refused before it reaches a path or a store key. */
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
export function checkId(v: unknown, what: string): string {
  const s = String(v ?? "");
  if (!ID.test(s)) throw new Error(`client timeline: bad ${what}`);
  return s;
}
/** Text from calls, emails and forms is data. It is trimmed and stripped of control characters before it is written anywhere. */
export const clip = (v: unknown, n = 4000) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n);
export const STATUSES: readonly string[] = ["open", "won", "lost", "abandoned"];
export const DAY = 864e5;
