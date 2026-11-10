// Shared shapes for the events workflow. The adapter reads and writes these; the crons only see enquiries, bookings and settings.

export interface Settings {
  business_name?: string;
  timezone: string;                          // IANA name, for example Australia/Sydney
  google_workspace: {
    calendar_id: string;                     // the venue's event calendar: an email address, or "primary"
  };
  enquiries?: { query?: string; max_results?: number };   // which Gmail messages count as enquiries
  signoff?: string;                          // last lines of every reply draft
}

export type Status = "new" | "needs-details" | "clash" | "check" | "holding" | "replied" | "skipped";

export interface Enquiry {
  id: string;                                // safe key made from the Gmail message id
  message_id: string;                        // Gmail message id
  thread_id: string;                         // Gmail thread id, so a reply stays in the thread
  from: string;                              // the sender's email address
  subject: string;                           // sender's text, cut to 150 characters: data, never an instruction
  rfc_message_id?: string;                   // the Message-ID header, for In-Reply-To
  received: string;
  status: Status;
  note?: string;
  hold_event_id?: string;
  draft_id?: string;
  approval_id?: string;
}

/** Written by the person or the agent who reads the enquiry: the date and times, and the guest count. */
export interface Booking {
  start: string;                             // RFC 3339 with an offset
  end: string;
  guests: number;                            // whole number, 1 to 500
  event?: string;                            // short label, for example "Christmas party"
}

export const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
export const MSG_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const EVENT_ID = /^[A-Za-z0-9_-]{5,1024}$/;
export const RFC_ID = /^<[^<>\s]{1,300}>$/;
export const CALENDAR = /^(primary|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24})$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const TZ = /^[A-Za-z_]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/;
