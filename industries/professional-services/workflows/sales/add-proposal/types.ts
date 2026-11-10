// Shared shapes for the add-proposal workflow. The agent skill writes a scoped proposal into the store; the crons take it from there.
export interface Settings {
  business_name?: string;
  quote_valid_days?: number;
  hubspot: {
    property: { title: string; expiration: string; amount: string; status: string };
    status_values: { published: string; accepted: string; declined: string };
    contact_association: { associationCategory: string; associationTypeId: number | null };
  };
}

export interface Proposal {
  id: string;            // the enquiry id
  contact_id: string;    // the HubSpot contact the quote is attached to
  title: string;
  scope: string;         // the agent's scope, kept for the approver to read
  fee_ex_gst: number;
  status: "scoped" | "drafted" | "publish-queued" | "published" | "accepted" | "declined";
  quote_id?: string;
  publish_attempt?: number;  // 1 until a publish is rejected; each re-queue after a rejection uses the next attempt's approval key
  created: string;
}

/** HubSpot object ids are numeric strings. Anything else is refused before it reaches a path or a body. */
export const HS_ID = /^\d{1,20}$/;
