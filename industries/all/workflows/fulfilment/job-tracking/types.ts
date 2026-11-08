// Shared shapes for the job-tracking workflow. Every adapter speaks these, so a step can point at either platform.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "servicem8" | "asana";

export interface Settings {
  family: "dispatched-field-jobs" | "project-milestone-jobs" | "unclear";
  business_name?: string;
  intake: Platform[];                          // where open jobs and projects are read from
  servicem8?: { client_channel?: "email" | "sms" };
  asana?: { workspace_gid: string; project_gids?: string[] };
  stall_days?: number;                         // no change for this many days = stalled (default 5)
  client_update_days?: number;                 // at most one client message per this many days (default 7)
}

export interface Contact { name?: string; email?: string; phone?: string }

/** One job (ServiceM8) or project (Asana) on the tracking record. */
export interface Tracked {
  key: string;
  platform: Platform;
  ref: Record<string, string>;
  title: string;
  status: string;
  contact: Contact;
  opened: string;
  last_activity?: string;
  stalled?: boolean;
  last_client_update?: string;
  closed?: string;
}

export interface Adapter {
  id: Platform;
  /** Open jobs or projects this platform holds. Reads only. */
  open(ctx: Ctx<Settings>): Promise<Omit<Tracked, "opened">[]>;
  /** Fresh status and last activity for one tracked job. Reads only. */
  refresh(ctx: Ctx<Settings>, t: Tracked): Promise<Partial<Tracked>>;
  /** An internal note the team reads. A draft operation. */
  note(ctx: Ctx<Settings>, t: Tracked, text: string): Promise<void>;
  /** A message a client or follower sees. Only ever queued for approval. */
  clientMessage(ctx: Ctx<Settings>, t: Tracked, subject: string, text: string, key: string): Promise<string | undefined>;
}

export const DAY = 864e5;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GID = /^\d{1,20}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE = /^\+[1-9]\d{6,14}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const keyOf = (s: string) => safeKey(s, 90);

/** A platform timestamp ("YYYY-MM-DD HH:MM:SS", taken as UTC, or ISO) as ISO. Undefined when it does not parse. */
export function ts(v: unknown): string | undefined {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  const iso = /T|Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** The latest of several ISO timestamps, ignoring blanks. */
export function latest(...v: (string | undefined)[]): string | undefined {
  const xs = v.filter((x): x is string => !!x).sort();
  return xs.length ? xs[xs.length - 1] : undefined;
}
