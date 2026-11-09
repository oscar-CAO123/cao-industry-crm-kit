// Shared shapes for the inbox-triage workflow. Each adapter speaks these, so a step can point at any platform.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "front" | "google-workspace";
export type Category = "work-order" | "quote-request" | "complaint" | "question" | "noise" | "other";

export interface Settings {
  business_name?: string;
  sources: Platform[];                                     // where shared mail comes from
  front?: { inbox_id: string; channel_id: string; teammate_id: string };
  google?: { label_name?: string };                        // the Gmail label put on every triaged thread (the mailbox comes from GOOGLE_MAILBOX)
  triage: { category: Category; match: string[] }[];       // first rule with a word in the subject or preview wins; otherwise "other"
  auto_reply: { category: Category; match?: string[]; body: string }[];  // approved template replies the draft cron may queue
  sla_hours?: number;                                      // reminder after this many hours (the four-hour target by default)
  lookback_hours?: number;                                 // only mail this recent is triaged (default 24); older mail is left alone
  per_run_limit?: number;                                  // most reply approvals one draft run queues (default 20)
  signature?: string;
}

export interface Sender { name?: string; email?: string }
export interface Enquiry {
  id: string; source: Platform; subject: string; preview: string; sender: Sender; received: string;
  ref: Record<string, string>;
  category?: Category;
  status: "triaged" | "skipped";
  replied?: string;      // approval id of the queued reply
  reply_error?: string;  // why no reply could be queued; a person answers, and the thread is still assigned or labelled
  assigned?: string;     // when the thread was assigned or labelled
}

export interface Adapter {
  id: Platform;
  /** Recent unassigned or unread mail from this source. Read only. */
  inbox(ctx: Ctx<Settings>): Promise<Omit<Enquiry, "status" | "category" | "replied" | "assigned">[]>;
  /** Queue one plain-text reply for approval; returns the approval id. */
  queueReply?(ctx: Ctx<Settings>, e: Enquiry, text: string): Promise<string>;
  /** Assign to a person or label the thread. Internal only. */
  assign(ctx: Ctx<Settings>, e: Enquiry): Promise<void>;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ID = /^[A-Za-z0-9_-]{1,120}$/;
export const keyOf = (s: string) => safeKey(s, 90);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** One line of text from outside the business: no line breaks, no runs of spaces, capped in length. */
export const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Customer text is matched against the rules and never run. The first rule with a matching word wins. */
export function classify(s: Settings, subject: string, preview: string): Category {
  const text = `${subject} ${preview}`.toLowerCase();
  const hit = s.triage.find((r) => r.match.some((m) => m && text.includes(m.toLowerCase())));
  return hit?.category ?? "other";
}

/** The approved template reply for this enquiry, or nothing. Noise never gets a reply. */
export function replyFor(s: Settings, e: Enquiry): string | undefined {
  if (!e.category || e.category === "noise") return undefined;
  const text = `${e.subject} ${e.preview}`.toLowerCase();
  const hit = s.auto_reply.find((r) => r.category === e.category && (!r.match?.length || r.match.some((m) => text.includes(m.toLowerCase()))));
  if (!hit) return undefined;
  return s.signature ? `${hit.body}\n\n${s.signature}` : hit.body;
}
