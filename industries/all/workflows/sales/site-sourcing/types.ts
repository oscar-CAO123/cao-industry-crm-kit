// Shared shapes for the site-sourcing workflow. The one adapter (adapters/domain.ts) speaks these.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "domain";
export const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"] as const;

export interface Settings {
  business_name?: string;
  search: {
    listing_type: "Sale" | "Rent";
    locations: { state: string; suburb: string; postcode?: string }[];
    /** Kept only when the listing's propertyType matches one of these. Empty keeps every type. */
    property_types?: string[];
    /** Smallest land area to keep, in the units Domain returns (landArea). Unknown areas are kept for a person to look at. */
    min_land_area?: number;
  };
  enquiry?: {
    sender: { firstName: string; lastName: string; email: string; phoneNumber: string; postcode: string };
    /** Owner's subject line; {address} is replaced with the listing's displayable address. */
    subject: string;
    /** Owner's message; {address} is replaced with the listing's displayable address. */
    message: string;
  };
}

export interface Candidate {
  key: string;
  platform: Platform;
  listing_id: string;
  address: string;
  state: string;
  suburb: string;
  postcode: string;
  latitude?: number;
  longitude?: number;
  property_type?: string;
  land_area?: number;
  headline?: string;
  status: "new" | "checked" | "shortlisted" | "enquiry-queued" | "enquired" | "skipped";
  reason?: string;
  found: string;
  checked?: string;
  desk?: { suburb_performance?: unknown; schools?: unknown };
  enquiry_approval?: string;
  /** Counts the shortlistings after a rejected enquiry; each one queues under its own approval key. */
  enquiry_round?: number;
}

export const candidateKey = (listingId: string) => safeKey(`domain:${listingId}`, 90);
