// Shared shapes for the meeting-actions workflow. Each notetaker adapter reads meetings and, where the kit maps it, builds
// the recap share that waits for approval. A meeting's actions come from the platform's own action list when it has one,
// otherwise from a proposal the agent writes (SKILL.md).
import type { Act, Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "fireflies" | "granola";

export interface Settings {
  business_name?: string;
  meeting_sources: Platform[];        // where meetings are recorded and read from
  recap_to?: string[];                // addresses a recap share goes to (Fireflies only); empty means no share is queued
  recap_expiry_days?: number;         // link expiry for a recap share: 7, 14 or 30
  lookback_days?: number;             // first run: how far back to read
  max_actions?: number;               // per meeting
  fireflies?: { limit?: number };
  granola?: { page_size?: number; max_transcript_pages?: number };
}

export interface Action { text: string; owner?: string; due?: string }

export interface Meeting {
  key: string; platform: Platform; id: string; title: string; when: string;
  summary: string; attendees: string[];
  action_items_source?: string;       // Fireflies: the platform's own action list, as written
  transcript?: string;                // Granola: transcript text, capped, for the agent to read
  fingerprint: string;                // changes when the platform's content changes
  status: "new" | "needs-notes" | "drafted";
  reason?: string; actions?: Action[]; overdue?: number; approval?: string;
}

export interface Proposal { summary: string; actions: Action[] }

/** One notetaker: how its meetings are read, and the recap share it can queue (when it has one). */
export interface Notetaker {
  id: Platform;
  meetings(ctx: Ctx<Settings>): Promise<Omit<Meeting, "status">[]>;
  shareAct?(m: Meeting, emails: string[], days: number): Act;
}

export const FIREFLIES_ID = /^[A-Za-z0-9_-]{1,120}$/;
export const GRANOLA_ID = /^not_[a-zA-Z0-9]{14}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const DUE = /^\d{4}-\d{2}-\d{2}$/;
export const cut = (v: unknown, n: number) => String(v ?? "").slice(0, n);
export const clamp = (v: unknown, lo: number, hi: number) => Math.min(Math.max(Math.floor(Number(v) || lo), lo), hi);
export const keyOf = (platform: Platform, id: string) => safeKey(`${platform}:${id}`, 120);
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** The platform's action list, one item per line, as actions. Bullets and numbers are stripped. */
export function actionsFromLines(text: string, max: number): Action[] {
  return text.split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, max)
    .map((l) => ({ text: l.slice(0, 300) }));
}

/** A proposal written by the agent, checked before it becomes actions. Returns the reason when it is not usable. */
export function checkProposal(p: unknown, max: number): Proposal | string {
  const x = p as any;
  if (!x || typeof x !== "object") return "proposal is not an object";
  if (!Array.isArray(x.actions) || !x.actions.length) return "proposal has no actions";
  if (x.actions.length > max) return `proposal has more than ${max} actions`;
  const actions: Action[] = [];
  for (const a of x.actions) {
    const text = typeof a?.text === "string" ? a.text.trim() : "";
    if (!text || text.length > 300) return "each action needs text of 1 to 300 characters";
    if (a.due !== undefined && (typeof a.due !== "string" || !DUE.test(a.due))) return "due must be YYYY-MM-DD";
    if (a.owner !== undefined && (typeof a.owner !== "string" || a.owner.length > 120)) return "owner must be a name of at most 120 characters";
    actions.push({ text, owner: a.owner || undefined, due: a.due || undefined });
  }
  return { summary: cut(x.summary, 1000), actions };
}
