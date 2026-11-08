// Shared shapes for the service-reminder workflow. ServiceM8 holds the jobs, contacts and messages.

export type Platform = "servicem8";

export interface Settings {
  family: "fleet-account-reminders";
  business_name?: string;
  service_interval_months?: number;   // months after the last completed job; default 12
  remind_before_days?: number;        // start reminding this many days before the service falls due; default 30
  channel?: "sms" | "email";          // preferred channel; the other is used when the customer has no match; default sms
  sms_template?: string;              // placeholders {first} and {business}
  email_subject?: string;
  max_per_run?: number;               // reminders queued per run; default 25
}

export interface Contact { name?: string; email?: string; phone?: string }
export interface Reply { uuid: string; at: string; text: string }

/** One completed job and the date its next service falls due. Keyed by the job's uuid in the "due" namespace. */
export interface Due {
  key: string; platform: Platform; job_uuid: string; address?: string; description?: string;
  completed: string; due: string; contact: Contact; seen: string; replies?: Reply[];
}

export const DAY_MS = 864e5;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE = /^\+[1-9]\d{6,14}$/;
export const DEFAULT_SMS = "Hi {first}, your vehicle is due for its next service with {business}. Reply to this message to book.";
export const DEFAULT_SUBJECT = "Your vehicle is due for a service";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** Plain text from outside the business: control characters out, whitespace collapsed, length capped. */
export const text = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const today = (d: Date) => d.toISOString().slice(0, 10);
/** Whole days from `from` to the date `ymd` (negative when it has passed). Dates are plain calendar days, so no time zone enters. */
export const daysUntil = (ymd: string, from: string) => Math.round((Date.parse(ymd) - Date.parse(from)) / DAY_MS);

/** Add whole months to a calendar date, clamping to the end of a short month. */
export function addMonths(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

const whole = (v: unknown, d: number, lo: number, hi: number, name: string) => {
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`service: ${name} must be a whole number from ${lo} to ${hi}`);
  return n;
};

/** Settings with defaults applied. A bad value stops the run instead of quietly changing a reminder. */
export function config(s: Settings) {
  const channel = s.channel ?? "sms";
  if (channel !== "sms" && channel !== "email") throw new Error("service: channel must be sms or email");
  return {
    interval: whole(s.service_interval_months, 12, 1, 60, "service_interval_months"),
    before: whole(s.remind_before_days, 30, 0, 90, "remind_before_days"),
    max: whole(s.max_per_run, 25, 1, 100, "max_per_run"),
    channel,
    template: s.sms_template ?? DEFAULT_SMS,
    subject: text(s.email_subject ?? DEFAULT_SUBJECT, 120),
  };
}

/** Fill the reminder template. Every value is plain text from the contact or the settings, capped. */
export const fill = (template: string, first: string, business: string) =>
  template.replaceAll("{first}", text(first, 40)).replaceAll("{business}", text(business, 80)).slice(0, 300);
