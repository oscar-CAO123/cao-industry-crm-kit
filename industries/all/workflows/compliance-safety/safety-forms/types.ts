// Shared shapes for the safety-forms workflow. The one adapter (SiteBook) speaks these.
export type Platform = "sitebook";

export interface Settings {
  family: "by-hand-or-unstated" | "other-tool" | "spreadsheet";
  business_name?: string;
  sitebook?: {
    job_id?: string;            // a SiteBook job GUID to limit every read to one job; empty means all jobs
    lookback_days?: number;     // how far back the checklist cron looks for completed checklists
    email_template_id?: string; // SiteBook email template for chase emails; empty means the default action template
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A SiteBook identifier, or undefined. Every id from outside passes through here before it reaches a path or a filter. */
export const guid = (v: unknown): string | undefined => { const s = String(v ?? ""); return GUID.test(s) ? s : undefined; };
/** Plain text from SiteBook, cut to a length and stripped of control characters. */
export const str = (v: unknown, max = 120) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, max);
/** SiteBook lists come back as a bare array, or as { list: [...] } on the checklists endpoint. */
export function rowsOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const l = (data as { list?: unknown })?.list;
  return Array.isArray(l) ? (l as T[]) : [];
}
export const DAY = 864e5;
