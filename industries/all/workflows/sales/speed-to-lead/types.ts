// Shared shapes for the speed-to-lead workflow. Settings come from the client's own file. Ids and text that come back
// from a platform are data: each one is checked before it goes into a path, a filter or a message.

export interface Settings {
  business_name: string;
  location_id: string;          // GoHighLevel location (sub-account) id
  pipeline_id: string;          // the pipeline new leads land in
  new_lead_stage_id: string;    // the stage that means nobody has contacted this lead yet
  owner_user_id: string;        // who gets the instant alert task
  senior_user_id: string;       // who gets the escalation task
  first_touch: { channel: "SMS"; after_minutes: number; message: string };  // {first} and {business} are filled in
  escalate_after_minutes: number;
  alert_window_hours?: number;  // a lead older than this when first seen gets no alert and no chase (default 24)
}

/** One new lead, keyed by platform and opportunity. `closed` says why the workflow has stopped working on it. */
export interface Lead {
  key: string; opp: string; contact: string; name: string; phone?: string; created: string;
  alerted?: string; chased?: string; escalated?: string; closed?: string;
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;

export function id(v: unknown, what: string): string {
  const s = typeof v === "string" ? v : "";
  if (!ID.test(s)) throw new Error(`speed-to-lead: bad ${what}`);
  return s;
}

/** Plain text from outside: control characters out, whitespace collapsed, length capped. */
export const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function phoneOf(v: unknown): string | undefined {
  const s = clean(v, 25);
  return /^\+?[0-9 ()-]{6,25}$/.test(s) ? s : undefined;
}

export function checkSettings(s: Settings): void {
  for (const [name, v] of Object.entries({ location_id: s.location_id, pipeline_id: s.pipeline_id, new_lead_stage_id: s.new_lead_stage_id,
    owner_user_id: s.owner_user_id, senior_user_id: s.senior_user_id })) id(v, `setting ${name}`);
  if (s.first_touch?.channel !== "SMS") throw new Error("speed-to-lead: first_touch.channel must be SMS");
  if (!(s.first_touch.after_minutes >= 0)) throw new Error("speed-to-lead: first_touch.after_minutes must be 0 or more");
  if (!(s.escalate_after_minutes > s.first_touch.after_minutes)) throw new Error("speed-to-lead: escalate_after_minutes must be later than first_touch.after_minutes");
}

/** The first text: the owner's template with the lead's first name and the business name filled in, as plain text. */
export function firstTouch(s: Settings, lead: Lead): string {
  const first = clean(lead.name.split(" ")[0], 30) || "there";
  return clean(s.first_touch.message.replace("{first}", () => first).replace("{business}", () => clean(s.business_name, 60)), 320);
}
