// Shared shapes for the pipeline workflow. Vendor field names come from the Reapit Foundations docs example for GET /contact/{id}.

export interface Settings {
  business_name?: string;
  stale_after_days?: number;   // an untracked prospect older than this is listed for follow-up
}

export interface VendorContact {
  id: string;                  // Reapit Foundations contact id, e.g. OXF18000001
  forename?: string;
  surname?: string;
  email?: string;
  mobilePhone?: string;
  modified?: string;
}

export interface Prospect {
  id: string;
  name: string;
  email?: string;
  mobile?: string;
  modified?: string;           // the vendor's modified stamp when last read
  first_seen: string;          // when this workflow first saw the contact
  stage: string;               // "untracked" until the agent sets a stage in the store
  stage_changed?: string;
  detail_checked?: string;     // when the single-contact read last ran for this prospect
}
