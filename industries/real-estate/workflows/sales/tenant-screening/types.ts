// Shared shapes for the tenant screening workflow. The one platform mapped in the kit for this job is Re-Leased
// (commercial leasing: contacts and tenancies). Screening checks happen outside the platform; their results come in
// through the CRM shell as the applicant's status and lease dates.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "re-leased";

export interface Settings {
  family: "all";
  business_name?: string;
  re_leased: {
    company_id: string;          // Re-Leased company GUID the applicant contacts belong to
    property_id: string;         // Re-Leased property GUID the tenancy is created on
    applicant_tag?: string;      // tag the agency puts on contacts who have applied
    is_residential?: boolean;    // false for commercial leases (the default)
    title_prefix?: string;       // the tenancy title starts with this, then the tenant name
  };
}

export interface Applicant {
  id: string;                    // Re-Leased contact GUID
  name: string;
  email?: string;
  status: "new" | "awaiting-checks" | "needs-contact-details" | "approved" | "declined";
  received: string;
  reason?: string;
  /** Set by the CRM shell after the checks are done. Dates are YYYY-MM-DD. */
  lease?: { start: string; end: string };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const keyOf = (s: string) => safeKey(s, 90);
/** Strip control characters from text that came from outside, and cap its length. */
export const clean = (s: unknown, max = 255) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
