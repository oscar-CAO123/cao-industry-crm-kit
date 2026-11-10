// Shared shapes for the booking workflow. Calendly is the one platform built here; the rest are listed in workflow.json gaps.
// Settings.intake names the platforms booking records come from. tools/deploy.ts reads that field to list the keys to inject.

export type Platform = "calendly";

export interface Settings {
  business_name?: string;
  intake: Platform[];
  calendly: { user_uri: string; lookahead_days?: number; no_show_grace_minutes?: number };
}

/** One invitee on one appointment, as the workflow last saw it. Key: calendly:<invitee uuid>. */
export interface Booking {
  key: string;
  platform: Platform;
  event: string;            // scheduled event uuid
  invitee: string;          // invitee URI; the no-show call takes it
  name?: string;
  email?: string;
  event_name?: string;
  starts: string;           // ISO time
  ends: string;             // ISO time
  status: "active" | "canceled";
  no_show?: string;         // the platform's no-show URI, when one already exists
  seen: string;             // when intake last read it
}

export const DAY_MS = 864e5;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const USER_URI = /^https:\/\/api\.calendly\.com\/users\/[A-Za-z0-9-]{1,80}$/;
export const EVENT_URI = /^https:\/\/api\.calendly\.com\/scheduled_events\/([A-Za-z0-9-]{1,80})$/;
export const INVITEE_URI = /^https:\/\/api\.calendly\.com\/scheduled_events\/([A-Za-z0-9-]{1,80})\/invitees\/([A-Za-z0-9-]{1,80})$/;

/** Text from a booking form is data: drop control characters, trim, cap the length. It is never shown as markup. */
export const text = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

/** Checks the settings before any call: a bad user URI fails here, not on the network. */
export function config(s: Settings) {
  const cal = s?.calendly;
  if (!cal || !USER_URI.test(String(cal.user_uri ?? ""))) throw new Error("booking-reminders: settings.calendly.user_uri must be https://api.calendly.com/users/<uuid>");
  const days = Math.min(60, Math.max(1, Math.floor(Number(cal.lookahead_days ?? 14)) || 14));
  const grace = Math.min(240, Math.max(0, Math.floor(Number(cal.no_show_grace_minutes ?? 15)) || 0));
  return { userUri: cal.user_uri, days, graceMs: grace * 60_000 };
}
