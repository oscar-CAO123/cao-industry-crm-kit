// Shared shapes for the owner contacts workflow. The VaultRE adapter and the Microsoft 365 adapter both speak these.

export type Platform = "vaultre" | "microsoft-365";

export interface Settings {
  business_name?: string;
  microsoft_365: { mailbox: string };
  owners_per_run?: number;   // consent checks per run (default 25)
  daily_limit?: number;      // outreach emails queued per run (default 20)
  outreach_subject?: string;
  outreach_body?: string;    // {first_name} and {business_name} are filled in
}

/** new: seen on VaultRE, not yet checked. eligible: recorded email consent, not blocked. no-consent: no email consent on record.
 *  blocked: on the do-not-call list or opted out. queued: an approval holds its send. */
export type OwnerStatus = "new" | "eligible" | "no-consent" | "blocked" | "queued";

export interface Owner {
  id: string;                // VaultRE contact id, as a string
  name: string;
  email?: string;
  mobile?: string;
  status: OwnerStatus;
  checked?: string;          // ISO time of the last consent check
  reason?: string;
  approval?: string;         // the approval that holds the send
  first_seen: string;
}

export interface Contact {
  id: number;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  emails?: string[];
  phoneNumbers?: { number?: string; type?: string }[];
  onDoNotCallList?: boolean;
  unsubscribe?: { email?: boolean; sms?: boolean; letters?: boolean };
}

export interface Consent { email: boolean; sms: boolean; phone: boolean; recorded?: string }
