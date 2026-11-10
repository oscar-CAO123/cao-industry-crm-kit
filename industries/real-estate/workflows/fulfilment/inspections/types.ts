// Shared shapes for the inspections workflow. One platform today (ServiceM8). The crons speak only these shapes.
export type Platform = "servicem8";

export interface Settings {
  platform?: "servicem8" | "rex";
  business_name?: string;
  inspection_match: string;     // a word in the job description that marks an inspection job, e.g. "inspection"
  report_max_photos?: number;   // photos attached to the owner's report email (default 10, at most 20)
}

export interface Inspection {
  id: string;                   // servicem8:<job uuid>
  job_uuid: string;
  title: string;
  address: string;
  contact: { name?: string; email?: string };
  assigned: boolean;            // an inspector is allocated to the job in ServiceM8
  visited?: string;             // the allocation's completion timestamp: the visit is done
  status: "open" | "drafted" | "queued";
  findings?: string;            // the staff notes on the job, as they went into the draft note
  photos?: string[];            // image attachment uuids on the job
  draft_note?: string;          // uuid of the ServiceM8 note holding the draft
  approval?: string;            // id of the approval that sends the owner's report
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A uuid from outside before it goes into a filter or a path. */
export const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("servicem8: bad uuid"); return s; };
export const IMAGE = /jpe?g|png|heic|gif|webp/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
