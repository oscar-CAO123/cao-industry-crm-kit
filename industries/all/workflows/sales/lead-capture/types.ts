// Shared shapes for the lead capture workflow. The GoHighLevel adapter speaks these; the crons in index.ts use them.
// Text that comes from a lead (names, chat messages) is data. It is cleaned here and escaped before it reaches HTML.

export type Platform = "gohighlevel";

export interface Settings {
  business_name?: string;
  gohighlevel: { location_id: string; pipeline_id?: string; new_stage_id?: string; owner_user_id?: string; form_id?: string };
  lead_tags?: string[];
  acknowledgement?: { channel: "Email" | "SMS"; subject?: string; text: string };
  follow_up?: { after_hours: number; max: number; text: string };
}

export interface RawLead {
  source: "form" | "live-chat";
  ref: string;            // the submission id or the conversation id, from the platform
  contactId: string;      // the contact GoHighLevel already holds for this lead
  name: string;
  email?: string;
  phone?: string;
  received: string;       // ISO time
}

export interface Lead extends RawLead {
  key: string;
  status: "captured" | "queued" | "replied";
  followups: string[];    // ISO times when a follow-up was queued
  opportunity?: string;
}

/** Vendor ids are letters, digits, underscores and hyphens only: safe in a path or a filter. */
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/;

/** Plain text from outside: strip control characters, cap the length. */
export const clean = (s: unknown, max: number): string => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Fill {first} and {business} in a message template. The result is still escaped by the caller. */
export const fill = (template: string, vars: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");

export const firstName = (name: string): string => clean(name, 60).split(" ")[0] || "there";
