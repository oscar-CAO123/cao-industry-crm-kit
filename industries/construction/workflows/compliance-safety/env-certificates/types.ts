// Shared shapes for the solar and electrical paperwork workflow (network connection applications and certificates).
export type Platform = "servicem8";

export interface Settings {
  business_name?: string;
  intake: Platform;                       // where jobs come from
  keywords: string[];                     // a job whose text holds one of these is paperwork to track
  evidence: Record<string, string[]>;     // label -> terms; a term found in an attachment's name or type counts as on file
  chase_every_days?: number;
}

export interface Tracked {
  uuid: string;
  title: string;
  address: string;
  company_uuid?: string;
  missing: string[];                      // evidence labels still not on file, from the last check
  checked?: string;
  chased_at?: string;
  chases?: number;                        // chase emails queued so far; part of each chase's approval key
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
