// Shared shapes for the policy-answers workflow. The adapter speaks these, so the crons never touch a platform directly.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "zendesk";

export interface Settings {
  intake: Platform[];                       // where policy questions arrive
  zendesk: { locale: string; group_id?: number | null };
  follow_up?: { after_days: number[] };
}

export interface Enquiry {
  id: string; source: Platform; title: string; text?: string; received: string;
  contact: { name?: string; email?: string };
  ref: Record<string, string>;
  status: "new" | "needs-answer" | "drafted";
  reason?: string;
}
export interface Article { id: string; title: string; body: string; html_url: string }
export interface Answer {
  key: string; enquiry: string; article_id: string; body: string;
  status: "draft" | "sent" | "closed"; followups: string[]; sent_at?: string;
}
export interface Adapter {
  id: Platform;
  enquiries(ctx: Ctx<Settings>): Promise<Omit<Enquiry, "status">[]>;
  articles(ctx: Ctx<Settings>): Promise<Article[]>;
  /** Current status of a ticket, or undefined when the platform does not say. */
  status(ctx: Ctx<Settings>, ticket: string): Promise<string | undefined>;
}

/** A platform id from outside: only a positive whole number may reach a path. */
export function ticketId(v: unknown): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`bad ticket id: ${String(v).slice(0, 20)}`);
  return n;
}
export const keyOf = (s: string) => safeKey(s, 90);
export const DAY = 864e5;
