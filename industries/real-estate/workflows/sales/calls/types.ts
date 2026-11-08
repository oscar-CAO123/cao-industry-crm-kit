// Shared shapes for the calls workflow. Field names come from the Reapit Foundations docs example (Agentbox contacts)
// and the Microsoft Graph v1.0 message schema (Outlook drafts).

export interface Settings {
  business_name?: string;
  microsoft_365?: { mailbox: string; folder?: string };   // the agency's own mailbox
  first_call_text?: string;                               // first-call email; {name} is the contact's first name
  follow_up?: { after_days: number[] };                   // days after the first-call send for each chaser
}

/** One contact the calls workflow is working. Only a person sets "to-contact", in the workflow store or the CRM shell. */
export interface CallLead {
  id: string;                                             // Agentbox contact id
  name: string;
  email?: string;
  first_seen: string;
  modified?: string;
  status: "new" | "to-contact" | "skipped" | "no-email" | "queued" | "sent";
  message?: string;                                       // Outlook draft id of the first-call email
  queued_at?: string;
  sent_at?: string;
  followups?: string[];                                   // when each chaser was queued
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
