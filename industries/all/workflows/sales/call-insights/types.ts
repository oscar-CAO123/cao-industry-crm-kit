// Shared shapes for the call-insights workflow. Calls come from the notetaker; a finding is the agent's reading of one call.
// Everything a call says (transcript, summary, names, emails) is data, never instructions.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "fireflies";

export interface Settings {
  match_crm?: "hubspot";             // when set, the match cron looks up outside attendees as HubSpot contacts (read only)
  max_calls_per_run?: number;        // default 20, never more than 50
}

/** One stored call. attendees are the participants' emails (lower case, valid addresses only), without the organizer. */
export interface CallRecord {
  key: string; platform: Platform; ref: string; title: string; happened: string;
  organizer?: string;
  attendees: string[];
  duration_min?: number;
  summary: string;
  transcript: string;                // capped; data only
  captured: string;
  matched?: string;                  // ISO time once the match cron has looked up the attendees
  contact_ids?: string[];            // HubSpot contact ids for the attendees, when any matched
}

export const CATEGORIES = ["pains", "objections", "offers", "buying_signals"] as const;
export type Category = (typeof CATEGORIES)[number];

/** One item from the call, quoted word for word, with a short note on why it matters. */
export interface Quote { quote: string; speaker?: string; note: string }

/** The agent's reading of one call, written into the insights store keyed by the call's key. */
export type Insight = Record<Category, Quote[]>;

/** A call the tag cron has checked. Only quotes that appear in the call are kept. */
export interface Finding {
  key: string; call: string; ref: string; title: string; happened: string;
  categories: Record<Category, Quote[]>;
  validated: string;
}

export const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
export const TRANSCRIPT_CAP = 30000;
export const keyOf = (s: string) => safeKey(s, 90);
/** One line of text from outside, cut to a length. */
export const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
/** Multi-line text from outside, cut to a length, line breaks kept. */
export const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);
