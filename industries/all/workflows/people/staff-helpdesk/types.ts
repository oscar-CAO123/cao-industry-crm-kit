// Shared shapes for the staff helpdesk workflow. Every adapter speaks these, so a question can be answered from any platform it came in on.
import type { Act, Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "google-workspace" | "slack";

export interface Settings {
  business_name?: string;
  intake: Platform[];                  // where staff questions arrive
  sources: Platform[];                 // where SOPs and policies are searched
  google?: {
    questions_query?: string;          // Gmail search for questions, e.g. label:staff-questions is:unread
    chat_space?: string;               // "spaces/AAAA" of a Chat space that takes questions
    drive_folder_id?: string;          // limit the SOP search to one Drive folder
    log?: { spreadsheet_id: string; range: string };   // question register, e.g. Questions!A:G
  };
  slack?: { channel: string };         // "C0123456789" of a Slack channel that takes questions
  max_sources?: number;
}

export interface Asker { name?: string; email?: string }
export interface Source { platform: Platform; id: string; title: string; url?: string }
export interface Question {
  id: string; source: Platform; title: string; text: string; asker: Asker; received: string;
  /** Where the reply goes: a Gmail thread, a Chat thread or a Slack thread. */
  thread: Record<string, string>;
  status: "new" | "needs-answer" | "drafted";
  sources?: Source[]; reason?: string; reply?: string; draft_id?: string; logged?: string;
}

export interface Adapter {
  id: Platform;
  questions(ctx: Ctx<Settings>): Promise<Omit<Question, "status">[]>;
  search(ctx: Ctx<Settings>, words: string[]): Promise<Source[]>;
  /** Turn a written answer into the approval act that sends it. A draft may be created on the way; nothing is sent here. */
  reply(ctx: Ctx<Settings>, q: Question, text: string): Promise<{ act: Act; draft_id?: string }>;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const keyOf = (s: string) => safeKey(s, 90);
/** Strip control characters and cap the length of text that came from outside. */
export const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
/** A single line, for subjects and titles: no line breaks, so no header can be injected. */
export const oneLine = (s: unknown, max: number) => clean(s, max * 2).replace(/[\r\n]+/g, " ").slice(0, max).trim();
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };

const STOP = new Set(["that", "this", "with", "from", "have", "what", "when", "where", "which", "does", "would", "could", "should", "about", "there", "their", "they", "your", "please", "thanks", "hello", "hi", "need", "know", "want", "just", "some", "more", "into", "like"]);
/** Search words from a question: plain lower-case letters only, so they are safe within a Drive or Slack query. */
export function keywords(text: string, max = 4): string[] {
  const words = [...new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)))];
  return words.slice(0, max);
}
