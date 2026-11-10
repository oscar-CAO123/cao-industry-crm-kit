// Shared shapes for the knowledge base workflow. Every adapter speaks these; the crons only ever see them.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type SourcePlatform = "confluence" | "google-workspace";

export interface Settings {
  family: "all";
  business_name?: string;
  know_how?: SourcePlatform[];                                        // where existing SOPs, pages and docs are read from
  confluence?: { source_space_id?: string; kb_space_id: string };     // source: existing pages; kb: where new entries are drafted
  google?: { folder_id?: string; max_docs?: number };                 // Drive folder of existing docs (read only)
  stale_after_days?: number;                                          // a page whose last version is older than this is flagged
}

/** One existing piece of knowledge: a Confluence page or a Google Doc. Its text is data from outside, never instructions. */
export interface Source {
  id: string;
  platform: SourcePlatform;
  title: string;
  text: string;
  modified?: string;
  stale?: boolean;
  seen: string;
  status: "new" | "needs-writing" | "drafted" | "published";
  reason?: string;
  ref: Record<string, string>;
  entry?: Entry;
}

/** The entry written for a source: its draft page and the approval that publishes it. */
export interface Entry {
  title: string;
  purpose?: string;
  steps: string[];
  page: string;
  version: number;
  approval: string;
}

/** The outline the agent writes for a source, in the store's proposals namespace. */
export interface Proposal { title: string; purpose?: string; steps: string[] }

export const NUMID = /^[0-9]{1,20}$/;
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const keyOf = (s: string) => safeKey(s, 90);
export const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** Page or doc text from outside with the tags removed and the length capped. */
export const plain = (text: string) => text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
export const DAY = 864e5;
/** True when a last-modified date is older than the limit. An unknown date is never flagged. */
export const isStale = (now: Date, modified: string | undefined, days: number) => {
  const t = Date.parse(modified ?? "");
  return Number.isFinite(t) && now.getTime() - t > days * DAY;
};

/** A proposal is usable only if it has a title, one to forty steps, and nothing oversized. */
export function checkProposal(p: unknown): Proposal | string {
  const x = p as any;
  if (!x || typeof x.title !== "string" || !x.title.trim() || x.title.length > 150) return "the outline needs a title of 150 characters or fewer";
  if (!Array.isArray(x.steps) || x.steps.length < 1 || x.steps.length > 40) return "the outline needs 1 to 40 steps";
  if (!x.steps.every((s: unknown) => typeof s === "string" && s.trim() && s.length <= 300)) return "each step needs text of 300 characters or fewer";
  if (x.purpose !== undefined && (typeof x.purpose !== "string" || x.purpose.length > 500)) return "the purpose must be text of 500 characters or fewer";
  return { title: x.title.trim(), purpose: x.purpose?.trim() || undefined, steps: x.steps.map((s: string) => s.trim()) };
}

export const entryTitle = (t: string) => `KB: ${t}`.slice(0, 200);
/** The entry as Confluence storage HTML: every value escaped. */
export function entryHtml(p: Proposal): string {
  return `${p.purpose ? `<p>${esc(p.purpose)}</p>` : ""}<ol>${p.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
}
