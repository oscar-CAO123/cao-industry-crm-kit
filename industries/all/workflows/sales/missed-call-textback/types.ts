// Shared shapes for the missed-call text-back workflow. Settings come from the client's own file. Ids, numbers and text
// that come back from a platform are data: each one is checked before it goes into a path, a filter or a message.

export interface Settings {
  business_name: string;
  justcall: { number: string };                              // E.164: the JustCall number callers ring and texts go from
  textback: { message: string; lookback_hours?: number };    // {business} is filled in; lookback default 24
  gohighlevel?: { location_id: string };                     // when set, each missed call is logged on the caller's contact
}

/** One missed call, keyed by platform and call id. `closed` says why the workflow has stopped working on it. */
export interface MissedCall {
  key: string; call_id: string; received: string; caller?: string;
  texted?: string; contact?: string; logged?: string; closed?: string;
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
export const PHONE = /^\+[1-9]\d{6,14}$/;

export function id(v: unknown, what: string): string {
  const s = typeof v === "string" ? v : "";
  if (!ID.test(s)) throw new Error(`missed-call-textback: bad ${what}`);
  return s;
}

/** Plain text from outside: control characters out, whitespace collapsed, length capped. */
export const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** A number as a platform shows it ("+61 412 345 678") in E.164, or undefined when it is not one. */
export function toE164(raw: unknown): string | undefined {
  const s = String(raw ?? "").replace(/[\s()-]/g, "");
  return PHONE.test(s) ? s : undefined;
}

/** A caller for approval summaries and the run log: the last four digits only. The full number stays in the send input and the note. */
export const masked = (phone: string): string => `caller ending ${String(phone).slice(-4)}`;

export function checkSettings(s: Settings): void {
  const bad = (what: string) => { throw new Error(`missed-call-textback settings: ${what}`); };
  if (typeof s.business_name !== "string" || !s.business_name.trim() || s.business_name.length > 60) bad("business_name must be 1 to 60 characters");
  if (!PHONE.test(s.justcall?.number ?? "")) bad("justcall.number must be E.164, for example +61412345678");
  if (typeof s.textback?.message !== "string" || !s.textback.message.trim() || s.textback.message.length > 300) bad("textback.message must be 1 to 300 characters");
  if (s.textback.lookback_hours !== undefined && !(s.textback.lookback_hours > 0 && s.textback.lookback_hours <= 168)) bad("textback.lookback_hours must be 1 to 168");
  if (s.gohighlevel) id(s.gohighlevel.location_id, "setting gohighlevel.location_id");
}

/** The text back: the owner's template with the business name filled in, as plain text. */
export function textBody(s: Settings): string {
  return clean(s.textback.message.replace("{business}", () => clean(s.business_name, 60)), 300);
}

export const lookbackMs = (s: Settings) => (s.textback.lookback_hours ?? 24) * HOUR;
