// Shared shapes for the client report workflow. Each adapter speaks these; the crons only read and draft.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "supermetrics" | "google-workspace";

export interface Client {
  name: string;
  contact_name?: string;
  contact_email: string;
  supermetrics: { ds_id: string; ds_accounts: string[]; fields: string[] };
}
export interface Settings {
  business_name?: string;
  clients: Client[];
}
export interface Period { key: string; start: string; end: string }
export interface Pull { key: string; client: string; period: string; rows: string[][]; pulled: string }
export interface Pack { key: string; client: string; period: string; draft_id: string; queued: string }
export interface Commentary { text: string }

export const SM_ID = /^[A-Za-z0-9_-]{1,50}$/;
export const FIELD = /^[a-z_]{1,50}$/;
export const GID = /^[A-Za-z0-9_-]{1,200}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

export const keyOf = (s: string) => safeKey(s, 90);
export const oneLine = (v: unknown, max: number) => String(v ?? "").replace(/[\r\n\t]+/g, " ").slice(0, max);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** The last full calendar month before `now`, in UTC. */
export function periodOf(now: Date): Period {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const first = new Date(Date.UTC(y, m - 1, 1)), last = new Date(Date.UTC(y, m, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { key: iso(first).slice(0, 7), start: iso(first), end: iso(last) };
}

/** Throws on anything that would reach a query or an address unchecked. */
export function checkClient(c: Client): void {
  const s = c?.supermetrics;
  if (!c?.name || !EMAIL.test(c.contact_email ?? "")) throw new Error(`report: ${c?.name ?? "client"} has no valid contact_email`);
  if (!s || !SM_ID.test(s.ds_id) || !s.ds_accounts?.length || !s.ds_accounts.every((a) => SM_ID.test(a))
      || !s.fields?.length || !s.fields.every((f) => FIELD.test(f))) throw new Error(`report: ${c.name} has bad supermetrics settings`);
}
