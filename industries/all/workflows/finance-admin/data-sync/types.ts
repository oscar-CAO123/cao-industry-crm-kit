// Shared shapes for the data-sync workflow. The crons speak these; the two adapters turn them into each platform's fields.

export interface Settings {
  business_name?: string;
  /** HubSpot company property that holds the Xero ContactID. It must already exist in HubSpot and be unique. */
  hubspot: { idProperty: string };
  /** Queue supplier bills that are drafts in Xero for a person to authorise. Off unless set. */
  sync_bills?: boolean;
}

/** A Xero contact. id is the Xero ContactID (a GUID). */
export interface Contact { id: string; name: string }
/** A Xero supplier bill in DRAFT. id is the Xero InvoiceID (a GUID). */
export interface Bill { id: string; number: string; supplier: string; total: number }
/** What the store keeps for each contact that has been linked, so a run can see what it already did. */
export interface Link { xero_id: string; hubspot_id?: string; name: string; synced: string }

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HS_ID = /^\d{1,20}$/;
export const HS_PROP = /^[a-z][a-z0-9_]{0,59}$/;

/** Plain text from outside: no control characters, trimmed, capped. */
export const clean = (s: unknown, max = 255) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
/** Xero's If-Modified-Since format: UTC, no milliseconds. */
export const dayTime = (d: Date) => d.toISOString().slice(0, 19);
