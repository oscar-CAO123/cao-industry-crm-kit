// Shared shapes for the settlement workflow. The Smokeball adapter and the crons speak these.
// Settlement dates are calendar events on the matter; the agreed date is written by the agent or a person (see SKILL.md).

export interface Settings {
  business_name?: string;
  matter_status: string[];      // Smokeball matter statuses to watch, e.g. ["Open"]
  settlement_subject: string;   // calendar event subject that marks a settlement, e.g. "Settlement"
  time_zone: string;            // IANA zone for the settlement event, e.g. "Australia/Sydney"
  horizon_days: number;         // how far ahead settlement events are read
  max_matters: number;          // open matters read per register run
  remind_days: number;          // days before settlement the reminder fires
  reminder?: { offset_type: string; offset_type_id: number; user_ids: string[] };
}

export interface SettlementEvent { event_id: string; date: string; subject: string }
/** The register: one entry per open matter, rewritten on every register run. */
export interface Matter { matter_id: string; status?: string; events: SettlementEvent[]; seen: string }
/** The agreed date for a matter. Written by the agent or a person; event_id is pinned by the check cron. */
export interface Agreed { matter_id: string; date: string; source: string; recorded: string; event_id?: string }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(v: unknown, what: string): string {
  const s = String(v ?? "");
  if (!UUID.test(s)) throw new Error(`settlement: bad ${what}`);
  return s;
}
/** A real calendar day as YYYY-MM-DD, or undefined. */
export function isDay(v: unknown): string | undefined {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? undefined : s;
}
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
