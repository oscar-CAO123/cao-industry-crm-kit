// Shared shapes for the maintenance workflow. Only ServiceM8 is mapped, so every step here speaks ServiceM8.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "servicem8";

export interface Settings {
  business_name?: string;
  job_status_open?: string;      // ServiceM8 job status that means an open work order (default "Work Order")
  job_status_done?: string;      // ServiceM8 job status that means finished (default "Completed")
  lockout_steps: string[];       // ordered lockout and isolation steps, written onto each work order checklist
}

export interface Contact { name?: string; email?: string; phone?: string }
export interface Asset { uuid: string; name: string; asset_code?: string }
export interface Request {
  id: string; job_uuid: string; title: string; text: string; asset?: string; contact: Contact; received: string;
  status: "new" | "checklist-drafted" | "notify-queued" | "no-contact";
}
export interface Closed { id: string; job_uuid: string; title: string; closed: string; parts: { name: string; quantity: string; price: string }[] }

export interface Adapter {
  id: Platform;
  openJobs?(ctx: Ctx<Settings>): Promise<Omit<Request, "status">[]>;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE = /^\+[1-9]\d{6,14}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const keyOf = (s: string) => safeKey(s, 90);
/** A ServiceM8 status name used inside a $filter: letters and spaces only, so nothing can break out of the quotes. */
export const statusName = (s: string) => { if (!/^[A-Za-z][A-Za-z ]{0,39}$/.test(s)) throw new Error(`maintenance: bad job status "${s.slice(0, 40)}"`); return s; };
export const SECTION = "Lockout and isolation";
