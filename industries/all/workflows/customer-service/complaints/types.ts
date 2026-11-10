// Shared shapes for the complaints workflow. The Gorgias adapter speaks these; every cron works through them.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "gorgias";

export interface Category {
  name: string;                                   // shown in approvals and written to the ticket's category field
  match: string[];                                // words that open the category (matched at the start of a word)
  ack?: string;                                   // acknowledgement queued for approval; it never promises a refund or a decision
}

export interface Settings {
  business_name?: string;
  gorgias?: { escalate_tag?: string; overdue_tag?: string; category_field_id?: number };
  categories: Category[];                         // checked in order; first match wins
  escalate?: string[];                            // words that always go to a person and never get an automatic acknowledgement
  lookback_hours?: number;                        // only tickets this recent are picked up (default 24)
  chase_after_hours?: number;                     // a complaint still open after this many hours gets the overdue tag (default 4)
  per_run_limit?: number;                         // most complaints one draft run handles (default 20)
  signature?: string;                             // added to the end of every acknowledgement
}

export interface Sender { name?: string; email?: string }
export interface Enquiry {
  id: string; source: Platform; subject: string; complaint: string; sender: Sender; received: string;
  ref: Record<string, string>;
  status: "new" | "escalated" | "needs-triage" | "categorised" | "ack-queued";
  category?: string;                              // the category that matched
  reason?: string;                                // why a person is needed, in plain words
  approval?: string;                              // approval id of the queued acknowledgement
  overdue_tagged?: string;                        // when the overdue tag was set
}
export type Raw = Omit<Enquiry, "status" | "category" | "reason" | "approval" | "overdue_tagged">;

export interface Adapter {
  id: Platform;
  /** Recent open tickets with the latest customer message. Read only. */
  inbox(ctx: Ctx<Settings>): Promise<Raw[]>;
  /** Ids of the open tickets right now. Read only. */
  openIds(ctx: Ctx<Settings>): Promise<Set<string>>;
  /** Write the category into the ticket's custom field, when one is configured. Internal record. */
  setCategory(ctx: Ctx<Settings>, e: Enquiry, category: string): Promise<void>;
  /** Queue the acknowledgement for approval. A send is always an approval. */
  queueAck(ctx: Ctx<Settings>, e: Enquiry, text: string): Promise<string>;
  /** Tag the ticket for a person. Internal only. */
  escalate(ctx: Ctx<Settings>, e: Enquiry): Promise<void>;
  /** Tag a still-open complaint as overdue. Internal only. */
  overdue(ctx: Ctx<Settings>, e: Enquiry): Promise<void>;
}

export const NUM = /^[1-9][0-9]{0,15}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const CHANNEL = /^[a-z_-]{1,40}$/;
export const TAG = /^[A-Za-z0-9 _-]{1,60}$/;
export const CATEGORY = /^[A-Za-z0-9 _-]{1,40}$/;
export const WORD = /^[a-z0-9' -]{2,40}$/i;
export const ANSWER_MAX = 4000;
export const HOUR = 3600e3;
export const DEFAULT_ESCALATE = ["injur", "lawyer", "solicitor", "legal", "lawsuit", "chargeback", "unsafe", "police", "compensation", "accc"];
export const keyOf = (s: string) => safeKey(s, 90);

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Plain text as escaped HTML paragraphs: a reply never carries markup from anywhere else. */
export const paragraphs = (text: string) =>
  text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

/** The first word from the list that starts a word in the text, or undefined. Words are checked before use. */
export function hit(words: string[], text: string): string | undefined {
  return words.find((w) => {
    if (!WORD.test(w)) throw new Error(`complaints: bad match word "${w}" in settings`);
    return new RegExp(`\\b${w.toLowerCase()}`, "i").test(text);
  });
}

/** Clear errors for a bad settings file, before any cron touches the platform. */
export function checkSettings(s: Settings) {
  if (!Array.isArray(s.categories) || !s.categories.length) throw new Error("complaints: settings need at least one category");
  const names = new Set<string>();
  for (const c of s.categories) {
    if (!c.name || !CATEGORY.test(c.name) || names.has(c.name)) throw new Error(`complaints: each category needs a unique plain name (${c.name ?? "missing"})`);
    names.add(c.name);
    if (!Array.isArray(c.match) || !c.match.length) throw new Error(`complaints: category ${c.name} needs match words`);
    for (const w of c.match) if (!WORD.test(w)) throw new Error(`complaints: bad match word "${w}" in category ${c.name}`);
    if (c.ack !== undefined && (c.ack.trim().length < 20 || c.ack.length > ANSWER_MAX || /\{\{|\{%/.test(c.ack))) throw new Error(`complaints: the acknowledgement for ${c.name} must be 20 to ${ANSWER_MAX} characters of plain text`);
  }
  for (const w of s.escalate ?? []) if (!WORD.test(w)) throw new Error(`complaints: bad escalation word "${w}"`);
  const g = s.gorgias ?? {};
  if (g.escalate_tag !== undefined && !TAG.test(g.escalate_tag)) throw new Error("complaints: escalate_tag must be plain words, numbers, spaces, - or _");
  if (g.overdue_tag !== undefined && !TAG.test(g.overdue_tag)) throw new Error("complaints: overdue_tag must be plain words, numbers, spaces, - or _");
  if (g.category_field_id !== undefined && !(Number.isInteger(g.category_field_id) && g.category_field_id > 0)) throw new Error("complaints: category_field_id must be a positive whole number");
}

/** A platform timestamp as ISO text, or the fallback when it does not read. */
export function isoOf(s: unknown, fallback: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(String(s ?? ""));
  if (!m) return fallback;
  const d = new Date(`${m[1]}${(m[2] ?? "").slice(0, 4)}${m[3] ?? "Z"}`);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}
