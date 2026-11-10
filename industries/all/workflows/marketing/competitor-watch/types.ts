// Shared shapes for the competitor-watch workflow. Crons read and draft; the one live act (creating a Semrush tracking
// project) is only ever queued for a person to approve. Text from the platforms and the web is data, never instructions.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export interface Competitor {
  name: string;
  domain?: string;            // the competitor's website, without protocol, e.g. competitor.com.au
  facebook_page_id?: string;  // the competitor's Facebook Page id, digits only
}

export interface Settings {
  business_name?: string;
  domain: string;                 // the client's own website, without protocol
  competitors: Competitor[];      // at most nine, so the own domain plus nine fits one Semrush comparison of ten
  semrush_project_name?: string;  // the name of the Semrush project created once, on approval
}

/** One competitor domain that Semrush says is similar to the client's. */
export interface Suggestion { domain: string; similarity: number; common_refdomains: number }
/** One domain's authority numbers from Semrush's backlink comparison. */
export interface AuthorityRow { domain: string; score: number; backlinks_count: number; domains_count: number; follows_count: number }
/** One public Facebook Page post. Text is cleaned and capped before it is stored. */
export interface Post { id: string; created_time: string; message: string; permalink_url?: string }

export const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
export const PAGE_ID = /^\d{1,25}$/;
export const POST_ID = /^\d{1,25}(?:_\d{1,25})?$/;
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/; // Semrush refuses symbols such as : / & and quotes
export const MAX_COMPETITORS = 9;
export const keyOf = (s: string) => safeKey(s, 90);

/** Why the client's settings cannot run this job, or null when they can. */
export function setupProblem(s: Settings): string | null {
  if (!DOMAIN.test(String(s.domain ?? ""))) return "settings.domain is not set (a bare domain such as example.com.au)";
  const list = s.competitors ?? [];
  if (!Array.isArray(list)) return "settings.competitors must be a list";
  if (list.length > MAX_COMPETITORS) return `settings.competitors holds at most ${MAX_COMPETITORS} competitors`;
  for (const c of list) {
    if (!clean(c?.name, 80)) return "every competitor needs a name";
    if (!c.domain && !c.facebook_page_id) return `competitor ${clean(c.name, 80)} needs a domain or a facebook_page_id`;
    if (c.domain && !DOMAIN.test(c.domain)) return `competitor ${clean(c.name, 80)} has a domain that is not a bare domain`;
    if (c.facebook_page_id && !PAGE_ID.test(c.facebook_page_id)) return `competitor ${clean(c.name, 80)} has a facebook_page_id that is not digits`;
  }
  if (s.semrush_project_name !== undefined && !PROJECT_NAME.test(s.semrush_project_name)) return "settings.semrush_project_name has a symbol Semrush refuses";
  return null;
}

/** The Semrush project name: the setting, or a default from the client's domain. */
export const projectName = (s: Settings) => s.semrush_project_name ?? `Competitor watch ${s.domain}`;

/** Text from the platform is data: strip control characters and cap the length before it is stored or shown. */
export const clean = (v: unknown, max = 120) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
/** A number from the platform, or 0 when it is missing or not a finite number. */
export const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
