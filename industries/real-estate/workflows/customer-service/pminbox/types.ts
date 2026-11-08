// Shared shapes for the pminbox workflow (morning property manager email). The mailbox is Gmail, the one mailbox
// platform in the kit that maps mail reads and drafts for this job.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "google-workspace";
export type Category = "urgent" | "maintenance" | "owner" | "tenant" | "noise" | "other";

export interface Settings {
  business_name?: string;
  digest_to: string;                                       // the manager's address for the morning summary draft
  triage: { category: Category; match: string[] }[];       // first rule with a word in the subject or preview wins; otherwise "other"
  auto_reply: { category: Category; match?: string[]; body: string }[];  // approved template replies the draft cron may queue
  signature?: string;
}

export interface Sender { name?: string; email?: string }
export interface Enquiry {
  id: string; subject: string; preview: string; sender: Sender; received: string;
  ref: Record<string, string>;
  category: Category;
  status: "triaged" | "skipped";
  replied?: string;      // approval id of the queued reply
  digested?: string;     // when this item went into a morning summary
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ID = /^[A-Za-z0-9_-]{1,120}$/;
export const keyOf = (s: string) => safeKey(s, 90);
/** One line of text from outside the business: no line breaks, no runs of spaces, capped in length. */
export const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, case-insensitive match. Customer text is matched against the rules and never run. */
const hasWord = (text: string, word: string) => !!word && new RegExp(`\\b${escapeRe(word)}\\b`, "i").test(text);

export function classify(s: Settings, subject: string, preview: string): Category {
  const text = `${subject} ${preview}`;
  const hit = s.triage.find((r) => (r.match ?? []).some((m) => hasWord(text, m)));
  return hit?.category ?? "other";
}

/** The approved template reply for this message, or nothing. Urgent and noise never get a template: a person answers them. */
export function replyFor(s: Settings, e: Enquiry): string | undefined {
  if (e.category === "urgent" || e.category === "noise") return undefined;
  const text = `${e.subject} ${e.preview}`;
  const hit = s.auto_reply.find((r) => r.category === e.category && (!r.match?.length || r.match.some((m) => hasWord(text, m))));
  if (!hit) return undefined;
  return s.signature ? `${hit.body}\n\n${s.signature}` : hit.body;
}
