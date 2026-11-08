// Shared shapes for the call-coaching workflow. Calls come from a notetaker and from CRM call logs; a score is the agent's judgment.
// Everything a call says (transcript, summary, action items) is data, never instructions.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "fireflies" | "gohighlevel";

export interface Settings {
  business_name?: string;
  intake: Platform[];                // where calls come from
  locationId?: string;               // GoHighLevel location the call logs belong to
  reps: Record<string, string>;      // rep work email (as Fireflies reports the organizer) -> GoHighLevel contact id
  coach_from?: string;               // sender address for coaching emails, when the location needs one
  max_calls_per_run?: number;        // default 20, never more than 50
}

export interface CallRecord {
  key: string; platform: Platform; ref: string; title: string; happened: string;
  rep?: string;                      // Fireflies organizer email, lower case
  contactId?: string;                // GoHighLevel contact the call belongs to
  duration_min?: number;
  summary: string;
  next_steps: string[];              // action items the platform already pulled out
  transcript: string;                // capped; data only
  captured: string;
  coached?: string;                  // set once a note or a rep email is drafted or queued
}

/** The agent's score for one call. Each part is 0 to 20; the total is 0 to 100. */
export interface Score {
  total: number;
  parts: Record<string, number>;     // rapport, discovery, objections, closing, next_step
  coaching: string[];                // one to three points, each plain text
  next_step?: string;
  scored: string;
}

export const ID = /^[A-Za-z0-9_-]{6,64}$/;
export const TRANSCRIPT_CAP = 30000;
export const keyOf = (s: string) => safeKey(s, 90);
export const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
