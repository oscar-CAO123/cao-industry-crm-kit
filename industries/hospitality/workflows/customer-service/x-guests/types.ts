// Shared shapes for the guests and waitlist workflow. The adapter reads and writes these; the crons only see entries and settings.
export { cell } from "../../../../construction/workflows/sales/quoting/types.ts";

export interface Settings {
  business_name?: string;
  timezone: string;                 // IANA name, for example Australia/Sydney
  minutes_per_group?: number;       // minutes each party ahead in the queue adds to the quoted wait (default 15)
  google_workspace: {
    spreadsheet_id: string;         // the waitlist spreadsheet
    waitlist_tab?: string;          // default "Waitlist"
    log_tab?: string;               // default "Guest log"
  };
}

/** The waitlist tab, columns A to H, in this order. The crons refuse a tab whose header row differs. */
export const COLUMNS = ["Guest", "Party size", "Added", "Quoted wait (min)", "Position", "Status", "Outcome time", "Note"];
/** The guest log tab, one row per party that left the queue. */
export const LOG_COLUMNS = ["Date", "Guest", "Party size", "Added", "Outcome", "Minutes waited"];
export const STATUSES = ["Waiting", "Ready", "Seated", "No show", "Left", "Check"];
/** Statuses that take a party out of the queue. */
export const DONE = ["Seated", "No show", "Left"];

export interface Entry {
  row: number;                      // the sheet row number (the header is row 1)
  guest: string;
  party: number | null;
  added: string;                    // RFC 3339 with an offset
  quoted: number | null;            // minutes, written by the queue cron
  position: number | null;          // place in the queue, written by the queue cron
  status: string;
  outcome: string;                  // RFC 3339 time the party was seated, marked no show or left
  note: string;
  raw: string[];                    // the eight cells as the sheet returned them, before any trimming: a clear is checked against these
}

export const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
export const SHEET_ID = /^[A-Za-z0-9_-]{20,200}$/;
export const TAB = /^[A-Za-z0-9 _-]{1,60}$/;
export const TZ = /^[A-Za-z_]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/;
