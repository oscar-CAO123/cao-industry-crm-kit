// Shared shapes for the pipeline-advance workflow. Both adapters speak these, so the crons do not care which CRM holds the deals.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "gohighlevel" | "pipedrive";
export interface Settings {
  platform: Platform;                 // where the deals live
  location_id?: string;               // GoHighLevel only: the sub-account (location) that holds the pipeline
  pipeline_id: string;                // the pipeline whose open deals are read and moved
  stage_order: string[];              // stage ids in pipeline order, first to last; a move may only go forward along it
  stale_after_days: number;           // an open deal with no change for this many days goes on the register
  read_limit: number;                 // most deals one scan reads; a longer list is cut short and the next scan starts again
}

/** A deal as a scan or a re-read sees it. lastChange is the latest change the platform reports (ISO time, or "" when none). */
export interface Deal { id: string; title: string; stage: string; status: string; lastChange: string }

/** One line of the register. The register lives in the workflow store; the CRM changes only when a queued approval runs. */
export interface Finding {
  key: string;
  platform: Platform;
  kind: "stalled";
  id: string;
  summary: string;
  status: "open" | "resolved";
  first_seen: string;
  seen_at: string;
}

/** A stage move recorded from what actually happened. One per deal (keyed by deal id). queue checks it and queues it for approval. */
export interface Move {
  deal: string;
  to: string;                         // the stage the deal should move to
  why: string;                        // short evidence from the deal's notes or activity, shown to the approver
  at: string;
  status?: "pending" | "queued" | "skipped";
  reason?: string;                    // why a move was skipped
  approval?: string;                  // the approval id once the move is queued
}

export interface Adapter {
  id: Platform;
  /** One page of open deals in the pipeline. next is the cursor for the following page, when there is one. */
  page(ctx: Ctx<Settings>, cursor?: string): Promise<{ items: Deal[]; next?: string }>;
  /** Re-read one deal before its move is queued. */
  get(ctx: Ctx<Settings>, id: string): Promise<Deal | undefined>;
  /** Queue one stage change for approval. */
  queueMove(ctx: Ctx<Settings>, d: Deal, to: string, key: string, summary: string): Promise<string>;
}

/** A record or stage id from outside: letters, digits, dash and underscore, so it can sit in a path or a body safely. */
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A page cursor from outside: a plain token. */
export const CURSOR = /^[A-Za-z0-9_=|.-]{1,500}$/;
/** One line of text from outside, cut to a length. */
export const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
/** The latest of several timestamps the platform gave, as ISO text. Pipedrive uses "YYYY-MM-DD HH:MM:SS" (UTC) or ISO; both parse. */
export function latest(...vals: unknown[]): string {
  let best = "", bestT = -Infinity;
  for (const v of vals) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    const t = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
    if (Number.isFinite(t) && t > bestT) { bestT = t; best = new Date(t).toISOString(); }
  }
  return best;
}
/** Days since an ISO time. A deal with no recorded time counts as infinitely old, so it goes on the register. */
export const daysSince = (iso: string, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / 864e5 : Infinity);

/** Refuse settings that cannot run before any call is made. */
export function checkSettings(s: Settings): void {
  if (s.platform !== "gohighlevel" && s.platform !== "pipedrive") throw new Error(`pipeline-advance: unknown platform ${String(s.platform)}`);
  if (!ID.test(String(s.pipeline_id ?? ""))) throw new Error("pipeline-advance: pipeline_id is not a plain id");
  if (s.platform === "gohighlevel" && !ID.test(String(s.location_id ?? ""))) throw new Error("pipeline-advance: GoHighLevel needs location_id");
  if (!Array.isArray(s.stage_order) || s.stage_order.length < 2 || s.stage_order.length > 50 || !s.stage_order.every((x) => ID.test(String(x))))
    throw new Error("pipeline-advance: stage_order needs 2 to 50 plain stage ids, first stage to last");
  if (new Set(s.stage_order).size !== s.stage_order.length) throw new Error("pipeline-advance: stage_order repeats a stage");
  if (!Number.isInteger(s.stale_after_days) || s.stale_after_days < 1 || s.stale_after_days > 365) throw new Error("pipeline-advance: stale_after_days must be a whole number from 1 to 365");
  if (!Number.isInteger(s.read_limit) || s.read_limit < 1 || s.read_limit > 5000) throw new Error("pipeline-advance: read_limit must be a whole number from 1 to 5000");
}
