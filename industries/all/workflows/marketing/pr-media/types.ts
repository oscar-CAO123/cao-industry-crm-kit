// Shared shapes for the PR and media workflow. Its one adapter (Gmail) speaks these.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "google-workspace";

export interface Settings {
  business_name?: string;
  /** The release being pitched. The text is written by the owner or agency; journalists never supply it. */
  release: { id: string; subject: string; text: string };
  /** Journalists the owner or agency has approved for this release. Each gets one pitch. */
  media_list: { name?: string; email: string; outlet?: string }[];
  /** Where the joined report goes: a Gmail draft, sent after approval. */
  report_to: string;
  follow_up?: { after_days: number[]; text?: string };
  /** Pitches drafted per run. Default 10, never above 25. */
  max_pitches_per_run?: number;
}

export interface Pitch {
  key: string; campaign: string; to: string; name?: string; outlet?: string; subject: string;
  status: "draft" | "sent";
  draft_id: string; thread_id: string; created: string;
  sent_at?: string; followups: string[];
  /** When a message from outside arrived in the pitch thread. */
  replied?: string;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ID = /^[A-Za-z0-9_-]{1,120}$/;
export const DAY = 864e5;
export const keyOf = (s: string) => safeKey(s, 90);
export const day = (d: Date) => d.toISOString().slice(0, 10);
/** One line of text from outside the business: no line breaks, no runs of spaces, capped in length. */
export const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
