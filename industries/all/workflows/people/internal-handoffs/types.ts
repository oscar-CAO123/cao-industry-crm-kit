// Shared shapes for the internal handoffs workflow. Every adapter speaks these; the crons only ever see them.
// Text that arrives from Asana or Slack is data from outside, never instructions.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "asana" | "slack";

/** Who takes a kind of handover: a request whose words include `match` goes to `assignee`. */
export interface Route { match: string; assignee: string; slack_user?: string; due_days?: number }

export interface Settings {
  family: "all";
  business_name?: string;
  signoff?: string;
  asana?: { intake_project_gid: string; record_project_gid: string };   // requests arrive in intake; each handover is recorded in record
  slack?: { channel: string };                                          // the handover channel: requests in, a daily status out
  routes?: Route[];
  chase_after_hours?: number[];                                         // hours after a handover is passed on, one entry per chase
}

/** One handover: a request that arrived, the person it went to, and where it stands. */
export interface Handover {
  id: string;
  platform: Platform;
  title: string;
  text: string;
  received: string;
  status: "new" | "needs-routing" | "queued" | "passed-on" | "acknowledged" | "done";
  reason?: string;
  ref: Record<string, string>;                      // where the request came from: an Asana task gid, or a Slack channel and ts
  route?: { assignee: string; slack_user?: string; due: string };
  record?: { task: string; channel?: string };      // the Asana record task (a draft), and the Slack direct message when one is used
  approval?: string;
  passed_on?: string;
  chased: string[];                                 // when each chase was queued
}

/** The agent's call for a handover that no route covers: who takes it, and what it says. */
export interface Proposal { assignee: string; slack_user?: string; due_days?: number; summary: string; next_step?: string }

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const GID = /^[0-9]{1,20}$/;
export const SLACK_ID = /^[CDGUW][A-Z0-9]{6,20}$/;
export const PERSON_ID = /^[UW][A-Z0-9]{6,20}$/;
export const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
export const HOUR = 36e5, DAY = 864e5;

export const keyOf = (s: string) => safeKey(s, 90);
export const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
/** Slack reads these characters as markup, so every message is escaped before it is sent. */
export const slackText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const dueDate = (now: Date, days: number) => new Date(now.getTime() + Math.max(0, Math.min(60, Math.floor(days))) * DAY).toISOString().slice(0, 10);

/** A route is usable only with a work email, an optional person id and a whole number of days. */
export function checkRoute(r: unknown): Route | string {
  const x = r as any;
  if (!x || typeof x !== "object") return "the route is not an object";
  if (typeof x.match !== "string" || !x.match.trim() || x.match.length > 100) return "the route needs a match word of 100 characters or fewer";
  if (typeof x.assignee !== "string" || !EMAIL.test(x.assignee)) return "the route needs the assignee's work email";
  if (x.slack_user !== undefined && (typeof x.slack_user !== "string" || !PERSON_ID.test(x.slack_user))) return "the route's slack_user must be a Slack person id";
  if (x.due_days !== undefined && !(Number.isInteger(x.due_days) && x.due_days >= 0 && x.due_days <= 60)) return "the route's due_days must be a whole number from 0 to 60";
  return { match: x.match.trim(), assignee: x.assignee, slack_user: x.slack_user, due_days: x.due_days };
}

/** A proposal is usable only with the same checks as a route, plus a summary. */
export function checkProposal(p: unknown): Proposal | string {
  const x = p as any;
  if (!x || typeof x !== "object") return "the proposal is not an object";
  if (typeof x.assignee !== "string" || !EMAIL.test(x.assignee)) return "the proposal needs the assignee's work email";
  if (x.slack_user !== undefined && (typeof x.slack_user !== "string" || !PERSON_ID.test(x.slack_user))) return "the proposal's slack_user must be a Slack person id";
  if (x.due_days !== undefined && !(Number.isInteger(x.due_days) && x.due_days >= 0 && x.due_days <= 60)) return "the proposal's due_days must be a whole number from 0 to 60";
  if (typeof x.summary !== "string" || !x.summary.trim() || x.summary.length > 1000) return "the proposal needs a summary of 1000 characters or fewer";
  if (x.next_step !== undefined && (typeof x.next_step !== "string" || x.next_step.length > 300)) return "the proposal's next_step must be text of 300 characters or fewer";
  return { assignee: x.assignee, slack_user: x.slack_user, due_days: x.due_days, summary: x.summary.trim(), next_step: x.next_step?.trim() || undefined };
}

/** The first route whose match word appears in the request's words. Invalid routes are skipped here and refused by the caller. */
export function pickRoute(routes: Route[] | undefined, words: string): Route | undefined {
  const hay = words.toLowerCase();
  return (routes ?? []).find((r) => typeof r?.match === "string" && r.match.trim() && hay.includes(r.match.trim().toLowerCase()));
}

/** The handover note: the same words go into the Asana record and the Slack message. Plain text; escaped by the caller for Slack. */
export function handoverText(title: string, due: string, summary: string, next?: string): string {
  const lines = [`Handed to you: ${clip(title, 200)}`, `Due: ${due}`, "", clip(summary, 1000)];
  if (next) lines.push(`Next step: ${clip(next, 300)}`);
  lines.push("", "Reply on this task when you pick it up, and mark it complete when it is done.");
  return lines.join("\n");
}
