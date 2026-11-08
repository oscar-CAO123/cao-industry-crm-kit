// Shapes for the reviews workflow. Two platforms carry the job in the kit: Podium (reviews and review invites) and
// GoHighLevel (the review request workflow and its tag). Every adapter speaks these shapes. No cron writes to a platform
// except through an approval a person has run.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "podium" | "gohighlevel";

export interface Settings {
  business_name?: string;
  review_platform: Platform;                                     // where this business's reviews and review requests live
  podium?: { location_uid: string };                             // the Podium location the reviews and invites belong to
  gohighlevel?: { review_workflow_id: string; asked_tag?: string }; // the workflow that sends the review request, and the tag that marks a contact as asked
  low_rating_max?: number;                                       // reviews at or under this rating are flagged for a person (default 3)
  ask_limit_per_run?: number;                                    // most completed jobs one ask run works on (default 20)
  reply_templates?: { positive?: string; negative?: string };    // the owner's own wording for drafts
}

/** A finished job the business wants a review for. Written to the `completed_jobs` namespace by the business's job tool or the CRM shell. */
export interface CompletedJob {
  id: string;                  // the business's own job id
  name?: string;               // customer name, for the approval summary
  email?: string;
  phone?: string;              // E.164, e.g. +61412345678
  contact_id?: string;         // GoHighLevel contact id, when the job is held there
  completed_at: string;        // ISO time the job was marked complete
  ask_id?: string;             // approval id once a review request is queued; a job is never queued twice
  problem?: string;            // why the last ask could not be queued
}

export interface ReviewRecord {
  uid: string;
  rating?: number;
  body?: string;
  author?: string;
  createdAt?: string;
  needsResponse: boolean;
}

/** A reply drafted for a person to read and post. Nothing in this workflow posts it. */
export interface ReplyDraft {
  uid: string;
  rating?: number;
  flagged: boolean;            // true for a low rating or no rating: read it before it goes anywhere
  draft: string;
  created: string;
}

export interface ReviewAdapter {
  id: Platform;
  /** Reviews the business holds (a draft read). Empty when the kit has no review read for the platform. */
  reviews(ctx: Ctx<Settings>): Promise<ReviewRecord[]>;
  /** Queue one review request for a completed job (live). Returns the approval id, or undefined when there is nobody to ask. */
  ask(ctx: Ctx<Settings>, job: CompletedJob): Promise<string | undefined>;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE = /^\+[1-9]\d{6,14}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ID = /^[A-Za-z0-9_-]{6,64}$/;
export const JOB_ID = /^[a-z0-9][a-z0-9:._-]{0,80}$/i;
export const keyOf = (s: string) => safeKey(s, 90);
/** Plain text from outside: control characters out, length capped. Never used as markup. */
export const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

/** A settings problem that stops both crons before any call. */
export function settingsProblem(s: Settings): string | undefined {
  if (s.review_platform === "podium") return s.podium?.location_uid && UUID.test(s.podium.location_uid) ? undefined : "podium.location_uid must be a Podium location uid";
  if (s.review_platform === "gohighlevel") return s.gohighlevel?.review_workflow_id && ID.test(s.gohighlevel.review_workflow_id) ? undefined : "gohighlevel.review_workflow_id must be set";
  return "review_platform must be podium or gohighlevel";
}
