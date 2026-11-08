// Shared shapes for the lead follow-up workflow. Both adapters speak these, so the crons do not care which CRM holds the leads.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "pipedrive" | "gohighlevel";
export type Role = "lead" | "quote";

export interface Watch { stage_id: string; role: Role }

export interface Settings {
  crm: Platform;                          // where the leads and quotes live
  business_name: string;
  pipeline_id: string;                    // the pipeline holding the leads and quotes
  location_id?: string;                   // GoHighLevel location (required there)
  watch: Watch[];                         // the stages this workflow follows up
  channel?: "sms" | "email";              // GoHighLevel: how a touch goes out (default sms); Pipedrive touches are drafted only
  email_subject?: string;
  follow_up: { after_days: number[] };    // touch n (n from 1) waits after_days[n-1] days after the previous touch
  lost_after_days?: number;               // queue a move to lost this many days after the last touch with no movement
  lost_reason?: string;                   // Pipedrive: lost reason text
  lost_reason_id?: string;                // GoHighLevel: lost reason id
  templates: { first_touch: string; quote_first?: string; follow_up: string[] };
}

export interface Lead {
  key: string;
  platform: Platform;
  id: string;                             // Pipedrive deal id, or GoHighLevel opportunity id
  role: Role;
  title: string;
  stage_id: string;
  status: "active" | "left-stage" | "lost";
  first_seen: string;
  seen_at: string;
  touches: number;                        // touches drafted so far (the first contact counts as 1)
  last_touch?: string;
  contact_id?: string;                    // GoHighLevel contact that a send goes to
  last_approval?: string;                 // approval id of the last queued send
  lost_queued?: string;                   // approval id of the queued move to lost
  moved_at?: string;
  reason?: string;                        // why a touch was held back
}

export interface Found { id: string; title: string; stage_id: string; status: string; contact_id?: string }

export interface Adapter {
  id: Platform;
  /** Open records in one watched stage. truncated is true when the platform returned a full page. */
  watched(ctx: Ctx<Settings>, w: Watch): Promise<{ items: Found[]; truncated: boolean }>;
  /** Record a touch inside the CRM only: a task or activity, and a note holding the message text. */
  draftTouch(ctx: Ctx<Settings>, lead: Lead, text: string, n: number): Promise<void>;
  /** Queue the message for approval. Only where the platform has a mapped send operation. */
  queueSend?(ctx: Ctx<Settings>, lead: Lead, text: string, key: string): Promise<string>;
  /** Queue the move to lost for approval. */
  queueLost(ctx: Ctx<Settings>, lead: Lead, key: string): Promise<string>;
}

export const DAY = 864e5;
/** A platform id from outside: letters, digits, underscore and dash only, so it can sit in a path or filter safely. */
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const leadKey = (p: Platform, id: string) => safeKey(`${p}:${id}`, 120);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** One line of text from outside, cut to a length. */
export const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
export const render = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** Refuse settings that cannot run before any call is made. */
export function checkSettings(s: Settings): void {
  if (s.crm !== "pipedrive" && s.crm !== "gohighlevel") throw new Error(`lead-followup: unknown crm ${String(s.crm)}`);
  if (!ID.test(String(s.pipeline_id ?? ""))) throw new Error("lead-followup: pipeline_id must be a plain id");
  if (s.crm === "gohighlevel" && !ID.test(String(s.location_id ?? ""))) throw new Error("lead-followup: location_id is required for gohighlevel");
  if (!Array.isArray(s.watch) || !s.watch.length) throw new Error("lead-followup: watch needs at least one stage");
  for (const w of s.watch) {
    if (!ID.test(String(w.stage_id ?? ""))) throw new Error("lead-followup: every watched stage_id must be a plain id");
    if (w.role !== "lead" && w.role !== "quote") throw new Error("lead-followup: role must be lead or quote");
  }
  if (!Array.isArray(s.follow_up?.after_days) || s.follow_up.after_days.some((d) => !(d > 0 && d <= 365))) throw new Error("lead-followup: after_days must be days between 1 and 365");
}

/** The next touch is due: the first contact at once, then each follow-up after its gap. */
export function touchDue(lead: Lead, s: Settings, now: Date): boolean {
  if (lead.status !== "active") return false;
  if (lead.touches === 0) return true;
  const gaps = s.follow_up.after_days;
  if (lead.touches > gaps.length || !lead.last_touch) return false;
  return now.getTime() - Date.parse(lead.last_touch) >= gaps[lead.touches - 1] * DAY;
}
