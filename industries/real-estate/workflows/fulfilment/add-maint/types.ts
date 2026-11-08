// Shared shapes for the maintenance dispatch workflow. The ServiceM8 adapter speaks these.
export type Platform = "servicem8";

export interface Settings {
  business_name?: string;
  platform: Platform;                 // where maintenance jobs live
  dispatch_staff_uuid: string;        // the maintenance person jobs are allocated to (a ServiceM8 staff uuid)
  owner_email?: string;               // who receives the completion update
  follow_up?: { after_days: number[]; channel?: "email" | "sms" };
}

export interface Contact { name?: string; email?: string; phone?: string }

export interface Job {
  job_uuid: string;
  title: string;
  address: string;
  contact: Contact;
  status: "new" | "dispatch-queued" | "in-work" | "done";
  received: string;
  staff_uuid?: string;
  dispatched_at?: string;
  followups?: string[];
  reported?: string;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE = /^\+[1-9]\d{6,14}$/;

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
