// Shared shapes for the safety paperwork workflow. The one adapter (SiteBook) speaks these.
import crypto from "node:crypto";

export type Platform = "sitebook" | "procore";

export interface Settings {
  business_name?: string;
  prestart?: { template_checklist_id: string; swms_id?: string; job_title_prefix?: string; asset_id?: string; asset_group_id?: string };
  swms_review_days?: number;        // how old a SWMS review may be before a review action is raised (default 90)
  swms_review_assignee?: string;    // SiteBook personnel id for review actions (optional)
  reminder_days?: number;           // remind about open actions due within this many days (default 2)
  reminder_template_id?: string;    // SiteBook email template for action reminders
  /** Procore incidents and inspections (separate crons from the SiteBook ones). Project ids are Procore's integers as digit strings. */
  procore?: { projects: { id: string; name: string }[]; reminder_distribution_ids?: string[] };
}

export const DAY = 864e5;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A SiteBook id from outside the kit: anything that is not a GUID is refused before it reaches a path or a body. */
export const guidOrNull = (v: unknown): string | null => { const s = String(v ?? ""); return GUID.test(s) ? s : null; };
export const guid = (v: unknown): string => { const g = guidOrNull(v); if (!g) throw new Error("sitebook: bad id"); return g; };
/** The array a list response carries: a bare array, or the named key. Anything else is an empty list. */
export const rows = (d: any, key: string): any[] => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : []);
export const first = (d: any, key: string): any => rows(d, key)[0] ?? (d && !Array.isArray(d) ? d : undefined);
export const newId = () => crypto.randomUUID();
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
