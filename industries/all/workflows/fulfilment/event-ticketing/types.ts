// Shared shapes for the event ticketing workflow. The Eventbrite adapter speaks these; field names come from Eventbrite's
// vendor spec (endpoint-map/raw/eventbrite/spec.apib): Event, Ticket Class, Attendee, Team and Pagination objects.

export interface Settings {
  business_name?: string;
  event_ids: string[];            // the Eventbrite event ids this workflow runs
  publish_when_ready?: boolean;   // false: setup only reports; true: setup queues each ready event's publish for approval
  run_sheet_days_ahead?: number;  // how far ahead run-day drafts a run sheet (default 7)
  timezone?: string;              // label on the run sheet (default: the event's own timezone)
}

export interface EventRow {
  id?: string;
  name?: { text?: string };
  status?: string;                // draft, live, started, ended, completed or canceled
  start?: { utc?: string; local?: string; timezone?: string };
  end?: { utc?: string; local?: string; timezone?: string };
  online_event?: boolean;
  venue_id?: string | null;
}

export interface TicketClass { id?: string; name?: string; quantity_sold?: number }

export interface Attendee {
  id?: string;
  changed?: string;
  order_id?: string;
  ticket_class_id?: string;
  ticket_class_name?: string;
  status?: string;
  checked_in?: boolean;
  cancelled?: boolean;
  refunded?: boolean;
  profile?: { name?: string; email?: string };   // email is read for nothing here and never stored
}

export interface Team { id?: string; name?: string; attendee_count?: number }

export interface Register {
  event_id: string; attendee_id: string; order_id?: string; name?: string; ticket_class?: string;
  status?: string; checked_in: boolean; cancelled: boolean; refunded: boolean; changed?: string;
}
