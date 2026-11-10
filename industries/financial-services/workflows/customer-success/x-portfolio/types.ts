// Portfolio reviews: the shared shapes. A review pack holds only the client-record properties the business names in settings.
// No holdings or performance data is read, because no mapped platform provides it yet (see workflow.json gaps).

export interface Settings {
  business_name?: string;
  timezone: string;
  hubspot: {
    name_property: string;        // the partner client property holding the client's name (the business's own name)
    due_property: string;         // the partner client property holding the next review date (the business's own name)
    pack_properties: string[];    // partner client properties copied into the review pack
    owner_id: string;             // HubSpot owner id of the adviser who runs the review
    organizer_user_id: string;    // HubSpot user id the calendar meeting is created under
  };
}

export type ReviewStatus = "not-due" | "due" | "prepared" | "invite-queued";
/** invite_approval is the approval the invite was queued under; invite_round counts invites rejected and queued again. */
export interface ClientRow { id: string; name: string; due?: string; status: ReviewStatus; invite_approval?: string; invite_round?: number }
export interface Slot { start: string; end: string }
export interface Pack { id: string; name: string; due: string; properties: Record<string, string>; prepared: string }

/** Keeps only the named properties, as plain text capped in length. Values are client data, never instructions. */
export const pick = (src: Record<string, string>, keys: string[]) => {
  const out: Record<string, string> = {};
  for (const k of keys) if (typeof src[k] === "string") out[k] = src[k].slice(0, 2000);
  return out;
};
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** HubSpot date properties come back as a date string or a millisecond timestamp. Undefined when unreadable. */
export function dueAt(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const t = /^\d{13}$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}
