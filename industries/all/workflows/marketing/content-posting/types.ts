// Shared shapes for the content-posting workflow. The only platform this job maps in the kit is Meta (Instagram and the
// Facebook Page), so the settings and the adapter speak Meta ids. Every post goes out through an approval, never from a cron.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Channel = "instagram" | "facebook";

export interface Settings {
  business_name?: string;
  channels: Channel[];                       // the channels this client posts to
  meta: { instagram_user_id?: string; facebook_page_id?: string };
  post_limit_per_run?: number;               // most planned posts one draft run works on (default 5)
  history_limit?: number;                    // most recent posts the track run reads per channel (default 25)
}

/** A post the owner or the agent has planned. Written to the `posts` namespace. The crons never write its text. */
export interface PlannedPost {
  id: string;
  caption: string;
  image_url?: string;                        // https, publicly reachable: Meta fetches the picture itself
  channels: Channel[];
  status: "planned" | "drafted" | "queued" | "skipped";
  reason?: string;
  instagram?: { creation_id: string };       // the unpublished Instagram container, once drafted
  queued?: string[];                         // approval ids, once queued: a queued post is never queued again
}

export const CAPTION_MAX = 2200;
export const POST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const NUM = /^\d{1,25}$/;
export const keyOf = (s: string) => safeKey(s, 90);

/** Why the client's settings cannot run this job, or null when they can. */
export function setupProblem(s: Settings): string | null {
  if (!Array.isArray(s.channels) || !s.channels.length) return "settings.channels is empty";
  if (s.channels.includes("instagram") && !NUM.test(s.meta?.instagram_user_id ?? "")) return "settings.meta.instagram_user_id is not set";
  if (s.channels.includes("facebook") && !NUM.test(s.meta?.facebook_page_id ?? "")) return "settings.meta.facebook_page_id is not set";
  return null;
}

/** A picture link Meta can fetch: https only, no credentials in the URL. */
export function imageOk(u: string): boolean {
  if (u.length > 2000) return false;
  try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password; } catch { return false; }
}

/** Why a planned post cannot go to these channels, or null when it can. Checked before any call. */
export function problem(p: PlannedPost, targets: Channel[]): string | null {
  if (!POST_ID.test(String(p.id ?? ""))) return "post id must be 1 to 80 letters, digits, dashes or underscores";
  const caption = String(p.caption ?? "").trim();
  if (!caption) return "caption is empty";
  if (caption.length > CAPTION_MAX) return `caption is over ${CAPTION_MAX} characters`;
  if (p.image_url !== undefined && !imageOk(String(p.image_url))) return "image_url must be an https link with no login in it";
  if (targets.includes("instagram") && !p.image_url) return "Instagram posts need an image_url in this workflow";
  return null;
}
