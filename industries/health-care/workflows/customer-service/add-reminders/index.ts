// The appointment reminders and waitlist crons. Each reads, drafts or queues; none sends.
// Cliniko's own SMS reminders go out from its templates. These crons only find the gaps, draft the text a person
// sends by hand, and queue a waitlist booking that a person has approved in the CRM shell.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import type { Appt, Draft, Opening, Settings } from "./types.ts";
import { cliniko } from "./adapters/cliniko.ts";

export const ADAPTERS = { cliniko };
const adapter = ADAPTERS.cliniko;
const HOUR = 36e5, DAY = 864e5;
const DIGITS = /^\d{1,12}$/;
const BOOK_OP = "individual-appointment.createindividualappointment";

const WHEN = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
const when = (iso: string) => WHEN.format(new Date(iso));

/** First name only, letters and hyphens or apostrophes; "there" when the name is missing or odd. */
export function firstName(full?: string): string {
  const first = (full ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-z][A-Za-z'-]{0,39}$/.test(first) ? first : "there";
}
/** Fill a plain-text template. Only the named fields are replaced; everything else is left as written. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(first_name|when)\}/g, (_, k: string) => vars[k] ?? "");
}
/** An appointment that is still on the book and still ahead. */
const live = (a: Appt, now: Date) => !a.cancelled_at && !a.archived_at && !a.deleted_at && !a.did_not_arrive && Date.parse(a.starts_at) > now.getTime();

/** Every 30 minutes: upcoming appointments with no reminder sent by Cliniko. Drafts the reminder text for a person to send. */
export async function reminders(ctx: Ctx<Settings>) {
  const now = ctx.now;
  const appts = await adapter.appointments(ctx, now, new Date(now.getTime() + ctx.settings.reminder_hours_ahead * HOUR));
  let drafted = 0;
  for (const a of appts) {
    if (!live(a, now) || a.sms_reminder_sent || a.email_reminder_sent) continue;
    const key = `reminder:${a.id}`;
    if (await ctx.store.get("drafts", key)) continue;
    const text = fill(ctx.settings.reminder_text, { first_name: firstName(a.patient_name), when: when(a.starts_at) });
    await ctx.store.put("drafts", key, { key, kind: "reminder", appointment: a.id, patient_id: a.patient_id, text, created: now.toISOString() } satisfies Draft);
    drafted++;
  }
  ctx.log(`reminders: ${drafted} drafted`);
  return { drafted };
}

/** Every 15 minutes: appointments cancelled in Cliniko that are still ahead. Each becomes an opening and a waitlist offer draft. */
export async function cancellations(ctx: Ctx<Settings>) {
  const now = ctx.now;
  const appts = await adapter.appointments(ctx, now, new Date(now.getTime() + ctx.settings.offer_window_days * DAY));
  let opened = 0;
  for (const a of appts) {
    if (!a.cancelled_at || a.archived_at || a.deleted_at || Date.parse(a.starts_at) <= now.getTime()) continue;
    if (await ctx.store.get("openings", a.id)) continue;
    await ctx.store.put("openings", a.id, { id: a.id, starts_at: a.starts_at, ends_at: a.ends_at, appointment_type_id: a.appointment_type_id,
      practitioner_id: a.practitioner_id, business_id: a.business_id, status: "open", created: now.toISOString() } satisfies Opening);
    const text = fill(ctx.settings.offer_text, { when: when(a.starts_at) });
    await ctx.store.put("drafts", `offer:${a.id}`, { key: `offer:${a.id}`, kind: "waitlist-offer", appointment: a.id, text, created: now.toISOString() } satisfies Draft);
    opened++;
  }
  ctx.log(`cancellations: ${opened} openings`);
  return { opened };
}

/** Booking fields for the create call, or undefined when any value from outside is not a plain id or a date. */
function bookingParams(o: Opening, patient: string): Record<string, string> | undefined {
  const ids = [o.appointment_type_id, o.practitioner_id, o.business_id].every((v) => v === undefined || DIGITS.test(v));
  if (!DIGITS.test(patient) || !ids || !o.appointment_type_id || !o.practitioner_id || Number.isNaN(Date.parse(o.starts_at))) return undefined;
  const p: Record<string, string> = { starts_at: o.starts_at, appointment_type_id: o.appointment_type_id, practitioner_id: o.practitioner_id, patient_id: patient };
  if (o.ends_at && !Number.isNaN(Date.parse(o.ends_at))) p.ends_at = o.ends_at;
  if (o.business_id) p.business_id = o.business_id;
  return p;
}

/** Every 30 minutes: queue a booking for each opening a person has marked accepted, once the slot is still free. Nothing books until approved. */
export async function waitlistBook(ctx: Ctx<Settings>) {
  const now = ctx.now;
  let queued = 0, booked = 0;
  for (const o of Object.values(await ctx.store.list<Opening>("openings"))) {
    if (o.status === "booking-queued") {
      const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `book:${o.id}`));
      if (ap?.status === "done") { o.status = "booked"; o.booked_ref = String(ap.results?.[0]?.ref?.id ?? ""); await ctx.store.put("openings", o.id, o); booked++; }
      continue;   // a failed or rejected booking waits for a person; it is never retried by the cron
    }
    if (o.status !== "accepted" || !o.accepted_by || Date.parse(o.starts_at) <= now.getTime()) continue;
    const params = bookingParams(o, o.accepted_by);
    if (!params) { ctx.log(`waitlist-book: opening ${o.id} has a value that is not a plain id or date; skipped`); continue; }
    // Re-check the slot right before queuing: someone may have booked it since.
    const t = Date.parse(o.starts_at);
    const same = (await adapter.appointments(ctx, new Date(t - 60e3), new Date(t + 60e3))).filter((a) => live(a, now) && (!o.practitioner_id || a.practitioner_id === o.practitioner_id));
    if (same.length) { o.status = "taken"; await ctx.store.put("openings", o.id, o); continue; }
    await ctx.queue({ platform: "cliniko", op: BOOK_OP, input: { params }, summary: `book patient ${o.accepted_by} into the opening at ${when(o.starts_at)}`, key: `book:${o.id}` },
      `Book patient ${o.accepted_by} into the opening at ${when(o.starts_at)}`);
    o.status = "booking-queued";
    await ctx.store.put("openings", o.id, o);
    queued++;
  }
  ctx.log(`waitlist-book: ${queued} queued, ${booked} booked`);
  return { queued, booked };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { reminders, cancellations, "waitlist-book": waitlistBook };
