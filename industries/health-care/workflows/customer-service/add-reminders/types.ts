// Shared shapes for the appointment reminders and waitlist workflow. The one adapter (Cliniko) speaks these.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "cliniko";

export interface Settings {
  business_name?: string;
  business_id?: string;          // Cliniko business id to limit reads to one site (digits only)
  reminder_hours_ahead: number;  // reminders are drafted for appointments starting within this many hours
  offer_window_days: number;     // waitlist offers are drafted for openings starting within this many days
  reminder_text: string;         // plain-text template: {first_name}, {when}
  offer_text: string;            // plain-text template: {first_name}, {when}
}

/** A Cliniko individual appointment, reduced to the fields this workflow reads (names from the vendor spec). */
export interface Appt {
  id: string;
  starts_at: string;
  ends_at?: string;
  patient_id?: string;
  patient_name?: string;
  appointment_type_id?: string;
  practitioner_id?: string;
  business_id?: string;
  cancelled_at?: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
  did_not_arrive?: boolean;
  sms_reminder_sent?: boolean;
  email_reminder_sent?: boolean;
}

/** A message drafted for a person to send by hand in Cliniko. Nothing here reaches a patient. */
export interface Draft {
  key: string;
  kind: "reminder" | "waitlist-offer";
  appointment: string;
  patient_id?: string;
  text: string;
  created: string;
}

/** A freed slot. A person records accepted_by when a waitlisted patient says yes; the cron then queues the booking. */
export interface Opening {
  id: string;                    // the cancelled appointment's id
  starts_at: string;
  ends_at?: string;
  appointment_type_id?: string;
  practitioner_id?: string;
  business_id?: string;
  status: "open" | "accepted" | "booking-queued" | "booked" | "taken";
  accepted_by?: string;          // patient id, set by a person
  booked_ref?: string;           // new appointment id, read from the approval result
  created: string;
}

export interface Adapter {
  id: Platform;
  /** Upcoming individual appointments that start between from and to (read only). */
  appointments(ctx: Ctx<Settings>, from: Date, to: Date): Promise<Appt[]>;
}
