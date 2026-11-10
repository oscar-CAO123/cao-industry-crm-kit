// Shared shapes for the bookings workflow. The adapter reads and writes these; the crons only see bookings and settings.
export { cell } from "../../../../construction/workflows/sales/quoting/types.ts";

export interface Settings {
  business_name?: string;
  timezone: string;                 // IANA name, for example Australia/Sydney
  google_workspace: {
    calendar_id: string;            // the venue calendar: an email address, or "primary"
    spreadsheet_id: string;         // the bookings spreadsheet
    bookings_tab?: string;          // default "Bookings"
    changes_tab?: string;           // default "Changes"
  };
}

/** The bookings tab, columns A to J, in this order. The crons refuse a tab whose header row differs. */
export const COLUMNS = ["Guest", "Headcount", "Start", "End", "Booked value", "Original value", "Logged value", "Status", "Event ID", "Note"];
export const STATUSES = ["Enquiry", "Holding", "Held", "Clash", "Check", "Moved", "Cancelled"];

export interface Booking {
  row: number;                      // the sheet row number (the header is row 1)
  guest: string;
  headcount: number | null;
  start: string;                    // RFC 3339 with an offset
  end: string;
  booked: number | null;
  original: number | null;          // the booked value when the hold was first made
  logged: number | null;            // the booked value last written to the Changes tab
  status: string;
  eventId: string;
  note: string;
  cells: unknown[];                 // the row exactly as the sheet returned it: the checks compare these, not the cleaned values
}

export const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
export const EVENT_ID = /^[A-Za-z0-9_-]{5,1024}$/;
export const SHEET_ID = /^[A-Za-z0-9_-]{20,200}$/;
export const TAB = /^[A-Za-z0-9 _-]{1,60}$/;
export const CALENDAR = /^(primary|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24})$/;
export const TZ = /^[A-Za-z_]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/;
