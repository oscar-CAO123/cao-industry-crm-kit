// Shared shapes for the customer-helpdesk workflow. Each adapter speaks these, so a step can point at either platform.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "front" | "gorgias";

export interface Rule {
  name: string;                                   // a short label, shown in the approval summary
  match: string[];                                // words that open the rule (matched at the start of a word)
  front?: { article_id: string };                 // a published Front knowledge base article with the answer
  gorgias?: { macro_id: number };                 // a Gorgias macro whose body is the answer
}

export interface Settings {
  business_name?: string;
  sources: Platform[];                            // where customer questions arrive
  front?: { inbox_id: string; channel_id: string; teammate_id: string };
  gorgias?: { escalate_tag?: string };            // internal tag put on tickets that need a person (default "needs-human")
  answers: Rule[];                                // the business's own answers, checked in order; first match wins
  escalate?: string[];                            // words that always go to a person and never get an automatic answer
  lookback_hours?: number;                        // only questions this recent are picked up (default 24)
  chase_after_hours?: number;                     // reminder on a waiting question after this many hours (default 4)
  per_run_limit?: number;                         // most enquiries one draft run handles (default 20)
  signature?: string;                             // added to the end of every answer
}

export interface Sender { name?: string; email?: string }
export interface Enquiry {
  id: string; source: Platform; subject: string; question: string; sender: Sender; received: string;
  ref: Record<string, string>;
  status: "new" | "escalated" | "needs-answer" | "answer-queued";
  rule?: string;                                  // the answer rule that matched
  reason?: string;                                // why a person is needed, in plain words
  approval?: string;                              // approval id of the queued reply
  chased?: string;                                // when a reminder was set
}
export type Raw = Omit<Enquiry, "status" | "rule" | "reason" | "approval" | "chased">;
export interface Answer { text: string }

export interface Adapter {
  id: Platform;
  /** Recent open questions the business has not answered yet, with the latest customer message. Read only. */
  inbox(ctx: Ctx<Settings>): Promise<Raw[]>;
  /** The plain-text answer behind a rule, or undefined when the rule has no usable reference on this platform. Read only. */
  knowledge(ctx: Ctx<Settings>, rule: Rule): Promise<Answer | undefined>;
  /** Queue one reply for approval. A send is always an approval. */
  queueReply(ctx: Ctx<Settings>, e: Enquiry, answer: Answer): Promise<string>;
  /** Hand the enquiry to a person inside the platform. Internal only. */
  escalate(ctx: Ctx<Settings>, e: Enquiry): Promise<void>;
  /** Remind a person to answer a waiting question. Internal only. Optional: a platform without a reminder skips this. */
  chase?(ctx: Ctx<Settings>, e: Enquiry): Promise<void>;
}

export const ID = /^[A-Za-z0-9_-]{1,120}$/;
export const NUM = /^[1-9][0-9]{0,15}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const CHANNEL = /^[a-z_-]{1,40}$/;
export const TAG = /^[A-Za-z0-9 _-]{1,60}$/;
export const WORD = /^[a-z0-9' -]{2,40}$/i;
export const ANSWER_MAX = 4000;
export const keyOf = (s: string) => safeKey(s, 90);

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Plain text from a help article or macro. Scripts and styles go, then every tag. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

/** Plain text as escaped HTML paragraphs: an answer never carries markup from the source. */
export const paragraphs = (text: string) =>
  text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

/** The first word from the list that starts a word in the text, or undefined. Words are checked before use. */
export function hit(words: string[], text: string): string | undefined {
  return words.find((w) => {
    if (!WORD.test(w)) throw new Error(`customer-helpdesk: bad match word "${w}" in settings`);
    return new RegExp(`\\b${w.toLowerCase()}`, "i").test(text);
  });
}

/** Clear errors for a bad settings file, before any cron touches a platform. */
export function checkSettings(s: Settings) {
  const names = new Set<string>();
  for (const r of s.answers ?? []) {
    if (!r.name || names.has(r.name)) throw new Error(`customer-helpdesk: each answer rule needs a unique name (${r.name ?? "missing"})`);
    names.add(r.name);
    if (!Array.isArray(r.match) || !r.match.length) throw new Error(`customer-helpdesk: answer rule ${r.name} needs match words`);
    for (const w of r.match) if (!WORD.test(w)) throw new Error(`customer-helpdesk: bad match word "${w}" in rule ${r.name}`);
    if (r.front && !ID.test(r.front.article_id ?? "")) throw new Error(`customer-helpdesk: bad Front article id in rule ${r.name}`);
    if (r.gorgias && !(Number.isInteger(r.gorgias.macro_id) && r.gorgias.macro_id > 0)) throw new Error(`customer-helpdesk: bad Gorgias macro id in rule ${r.name}`);
  }
  for (const w of s.escalate ?? []) if (!WORD.test(w)) throw new Error(`customer-helpdesk: bad escalation word "${w}"`);
  for (const p of s.sources ?? []) if (p !== "front" && p !== "gorgias") throw new Error(`customer-helpdesk: unknown source ${p}`);
}

/** A platform timestamp as ISO text, or the fallback when it does not read. */
export function isoOf(s: unknown, fallback: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(String(s ?? ""));
  if (!m) return fallback;
  const d = new Date(`${m[1]}${(m[2] ?? "").slice(0, 4)}${m[3] ?? "Z"}`);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}
