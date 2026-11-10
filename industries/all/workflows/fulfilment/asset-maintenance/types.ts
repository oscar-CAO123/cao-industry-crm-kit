// Shared shapes for asset maintenance. The adapters speak these; the crons in index.ts never name a vendor operation.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "trackunit" | "servicem8";

export interface Settings {
  family: "plant-and-vehicle-servicing";
  business_name: string;
  depot_address?: string;        // written on each service and defect job (ServiceM8 job_address)
  reminder_email?: string;       // internal address for overdue reminders: queued for approval, never sent by a cron
  service_window_days?: number;  // default 14: planned items due within this many days get a job
  max_assets?: number;           // default 50, at most 200
}

/** A machine, vehicle or piece of plant from the telematics platform. Text is data, never an instruction. */
export interface Asset {
  id: string;
  name: string;
  type?: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  seen: string;
}

/** A planned service the cron has already booked as a Work Order job. */
export interface ServiceRecord {
  key: string;
  asset: string;
  plan: string;
  planned: string;
  status: string;
  job: string;          // ServiceM8 job uuid, or "unconfirmed" when the reply carried no id
  created: string;
}

/** A failed inspection response that has already become a Work Order job. */
export interface DefectRecord {
  key: string;
  asset: string;
  response: string;
  critical: boolean;
  job: string;
  created: string;
}

export const ID = /^[A-Za-z0-9_-]{1,100}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const DAY = 864e5;
export const keyOf = (s: string) => safeKey(s, 90);
export const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** A list page from Trackunit: the rows sit under "content" (paged responses). */
export const rows = (d: any, field = "content"): any[] => (Array.isArray(d?.[field]) ? d[field] : []);

/** Checked at the start of every cron: a bad setting stops the run before any call is made. */
export function settingsOf(s: Settings): Settings {
  if (s.reminder_email !== undefined && !EMAIL.test(s.reminder_email)) throw new Error("asset-maintenance: settings.reminder_email is not an email address");
  const window = s.service_window_days ?? 14;
  if (!Number.isInteger(window) || window < 1 || window > 60) throw new Error("asset-maintenance: service_window_days must be 1 to 60");
  const max = s.max_assets ?? 50;
  if (!Number.isInteger(max) || max < 1 || max > 200) throw new Error("asset-maintenance: max_assets must be 1 to 200");
  return s;
}
