// Shared shapes for the breakdown fix finder. Only ServiceM8 is mapped for this job, so the adapter is the only platform.

export interface Settings {
  business_name?: string;
  breakdown_status?: string;      // the ServiceM8 job status that means a breakdown is open (set per client)
  escalate_after_hours?: number;  // default 4
  escalation_email?: string;      // who receives an escalation (supervisor or equipment supplier)
}

export interface Fault {
  id: string;                     // servicem8:<job uuid>
  job_uuid: string;
  company_uuid?: string;
  title: string;
  text: string;
  address: string;
  seen: string;                   // when intake first saw the breakdown
  status: "new" | "triaging" | "triaged" | "escalation-queued" | "recorded" | "closed";
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const STATUS = /^[A-Za-z][A-Za-z ]{0,39}$/;

/** A status name goes into a ServiceM8 filter, so it is checked before use. */
export function breakdownStatus(s: Settings): string {
  const v = s.breakdown_status ?? "Work Order";
  if (!STATUS.test(v)) throw new Error("faultfind: breakdown_status must be letters and spaces only");
  return v;
}

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
