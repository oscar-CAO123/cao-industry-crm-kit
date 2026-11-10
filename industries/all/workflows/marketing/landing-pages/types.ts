// Shared shapes for the landing-pages workflow. Webflow and GoHighLevel hold the pages and forms. The crons read them
// for the owner and queue every page change for a person's approval; nothing here publishes on its own.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "webflow" | "gohighlevel";

export interface Settings {
  business_name?: string;
  webflow?: { site_id: string; locale_id: string; custom_domain_ids?: string[] };
  gohighlevel?: { location_id: string };
  results_days?: number;
}

export interface PageRow { platform: Platform; id: string; name: string; seen: string }
export interface FormRow { platform: Platform; id: string; name: string; seen: string }
export interface Results { platform: Platform; form_id: string; form: string; since: string; submissions: number; seen: string }

/** A page change written into the store by the CRM shell. nodes are Webflow DOM nodes, each with a string id. */
export interface Change {
  id: string;
  platform: Platform;
  page_id: string;
  nodes: { id: string; [k: string]: unknown }[];
  publish: boolean;
  requested: string;
  status: "requested" | "queued" | "skipped";
  reason?: string;
  approval?: string;
}

/** Webflow object ids are 24 hex characters; GoHighLevel ids are short alphanumeric strings. */
export const WEBFLOW_ID = /^[a-f0-9]{24}$/i;
export const GHL_ID = /^[A-Za-z0-9]{8,40}$/;
export const DAY = 864e5;
export const keyOf = (s: string) => safeKey(s, 90);
export const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
export const days = (s: Settings) => s.results_days ?? 7;
export const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** An id from outside, checked before it goes into a path or a query. */
export function checked(v: unknown, re: RegExp, what: string): string {
  const s = String(v ?? "");
  if (!re.test(s)) throw new Error(`landing-pages: bad ${what}`);
  return s;
}
