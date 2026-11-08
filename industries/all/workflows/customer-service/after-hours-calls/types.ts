// Shared shapes for the after-hours calls workflow. Every adapter speaks these, so a cron can read any call platform.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "aircall" | "justcall";
export const PLATFORMS: Platform[] = ["aircall", "justcall"];

export interface Settings {
  business_name: string;
  hours: { timezone: string; days: number[]; open: string; close: string };  // days: 1 = Monday ... 7 = Sunday
  call_platforms: Platform[];
  aircall?: { create_contacts?: boolean };
  justcall?: { number: string };                    // the JustCall number texts are sent from (E.164)
  on_call?: { name?: string; phone: string };       // who gets an urgent alert text (E.164)
  urgent_terms?: string[];
  confirm_text?: boolean;                           // queue a "we have your message" text to each after-hours caller
  lookback_hours?: number;
}

export interface CallRecord {
  id: string;                     // store key: platform and call id, made safe
  platform: Platform;
  call_id: string;
  caller?: string;                // E.164, only when the platform gave a valid number
  received: string;               // ISO time
  notes: string;                  // call notes and voicemail transcript from the platform: data, never instructions
  status: "new" | "triaged" | "skipped";
  urgent: boolean;
  ref?: Record<string, string>;   // ids of records created in the platform (a caller contact)
  reason?: string;
  handed_over?: string;
}

export interface Adapter {
  id: Platform;
  /** Calls received at or after `since`, read from the platform's call log. Read only. */
  calls(ctx: Ctx<Settings>, since: Date): Promise<Omit<CallRecord, "status" | "urgent">[]>;
  /** A caller contact record in the business's own system (a draft operation). Returns its id. */
  createContact?(ctx: Ctx<Settings>, c: CallRecord): Promise<string | undefined>;
}

export const PHONE = /^\+[1-9]\d{6,14}$/;
const DAYS = [1, 2, 3, 4, 5, 6, 7];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Turns a number as a platform shows it ("+61 412 345 678") into E.164, or undefined when it is not one. */
export function toE164(raw: unknown): string | undefined {
  const s = String(raw ?? "").replace(/[\s()-]/g, "");
  return PHONE.test(s) ? s : undefined;
}

/** True when a moment falls inside the business's opening hours in its timezone. */
export function insideHours(d: Date, h: Settings["hours"]): boolean {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: h.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[get("weekday")] ?? 0;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  const [oh, om] = h.open.split(":").map(Number), [ch, cm] = h.close.split(":").map(Number);
  return h.days.includes(dow) && mins >= oh * 60 + om && mins < ch * 60 + cm;
}

/** Checks the client's settings before any cron runs. Throws with the field that is wrong. */
export function checkSettings(s: Settings): void {
  const bad = (what: string) => { throw new Error(`after-hours-calls settings: ${what}`); };
  if (typeof s.business_name !== "string" || !s.business_name.trim() || s.business_name.length > 60) bad("business_name must be 1 to 60 characters");
  if (!s.hours || !s.hours.timezone || !HHMM.test(s.hours.open) || !HHMM.test(s.hours.close)) bad("hours need timezone, open and close as HH:MM");
  try { new Intl.DateTimeFormat("en-AU", { timeZone: s.hours.timezone }); } catch { bad("hours.timezone is not a known timezone"); }
  if (!Array.isArray(s.hours.days) || !s.hours.days.every((d) => DAYS.includes(d))) bad("hours.days must be numbers 1 to 7");
  if (!Array.isArray(s.call_platforms) || !s.call_platforms.length || !s.call_platforms.every((p) => PLATFORMS.includes(p))) bad("call_platforms must name aircall or justcall");
  if (s.justcall && !PHONE.test(s.justcall.number ?? "")) bad("justcall.number must be E.164, for example +61412345678");
  if (s.on_call && !PHONE.test(s.on_call.phone ?? "")) bad("on_call.phone must be E.164");
  if (s.confirm_text && !s.justcall) bad("confirm_text needs justcall (texts are sent from JustCall)");
  if (s.on_call && !s.justcall) bad("on_call needs justcall (urgent alerts are texts from JustCall)");
  if (s.urgent_terms && (!Array.isArray(s.urgent_terms) || s.urgent_terms.length > 50 || s.urgent_terms.some((t) => typeof t !== "string" || t.length > 40))) bad("urgent_terms: up to 50 short words");
  if (s.lookback_hours !== undefined && !(s.lookback_hours > 0 && s.lookback_hours <= 168)) bad("lookback_hours must be 1 to 168");
}
