// Shared shapes for the referral-partners workflow. Referred leads come from Pipedrive; the referring partner is kept
// and messaged in ActiveCampaign. Each adapter names the vendor spec its fields come from.

export type Platform = "pipedrive" | "activecampaign";

export interface Settings {
  family: "referral-partners";
  business_name?: string;
  intake: "pipedrive";                  // where referred leads land
  partners: "activecampaign";           // where referring partners are kept and tagged
  pipedrive: {
    referral_label_id: string;          // UUID of the lead label that marks a referral
    partner_email_field: string;        // 40-character key of the lead custom field holding the referring partner's email
  };
  activecampaign: {
    acknowledged_tag: string;           // tag applied when a referral is acknowledged; the business's automation emails on it
    stage_tags: Record<string, string>; // Pipedrive stage id (as a string) -> tag applied when a referred deal reaches it
  };
}

export interface Referral {
  key: string;                          // "lead:<uuid>"
  lead_id: string;
  title: string;
  partner_email: string;
  status: "new" | "needs-partner-email" | "acknowledge-queued" | "acknowledged" | "declined";
  received: string;
  deal_id?: number;
  tagged_stage?: number;                // the Pipedrive stage whose tag was last queued
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const FIELD_KEY = /^[a-f0-9]{40}$/i;
/** ActiveCampaign tag names: letters, digits, spaces, hyphens and underscores; no commas, no emoji. */
export const TAG = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,49}$/;
export const DAY = 864e5;

export const ackKey = (r: Referral) => `ack:${r.lead_id}`;
export const stageKey = (dealId: number, stage: number) => `stage:${dealId}:${stage}`;

/** The referring partner's email from a Pipedrive lead's custom field, or undefined when it is missing or not an email. */
export function partnerEmail(s: Settings, row: Record<string, unknown>): string | undefined {
  const v = String(row[s.pipedrive.partner_email_field] ?? "").trim().toLowerCase();
  return EMAIL.test(v) ? v : undefined;
}
