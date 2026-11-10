// Shared shapes for the lead reactivation workflow. The lapsed list is read from GoHighLevel contacts. The send goes out one of
// two ways: GoHighLevel enrols each contact in a campaign built there, or Klaviyo sends one campaign to its own audience.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "gohighlevel" | "klaviyo";

export interface Settings {
  business_name: string;
  send: Platform;                       // where the reactivation message goes out
  location_id?: string;                 // GoHighLevel location (required when send is gohighlevel)
  lapsed_tag: string;                   // the tag the business puts on people it has not heard from in a while: the list
  sent_tag: string;                     // added once a contact is enrolled, so it is never picked up twice
  campaign_id?: string;                 // GoHighLevel: the campaign contacts are enrolled in (built in GoHighLevel)
  klaviyo?: { campaign_id: string; revision?: string };  // Klaviyo: the campaign whose audience is the lapsed segment
  batch?: number;                       // contacts per approval, 1 to 5 (an approval holds up to five acts)
  per_run?: number;                     // most contacts queued in one run (default 50)
  max_pages?: number;                   // GoHighLevel: pages of 100 contacts read per list run (default 60)
  task_after_days?: number;             // GoHighLevel: a person is tasked to check each enrolled contact this many days later (default 7)
}

export interface Candidate {
  key: string;
  id: string;                           // GoHighLevel contact id
  email?: string;
  status: "candidate" | "queued" | "sent" | "tasked";
  seen: string;
  approval?: string;                    // approval id that holds the enrolment
  sent_at?: string;
  tasked_at?: string;
  tag_error?: string;                   // the last failure to tag the contact as sent; the contact stays queued and is tried again
}

export const DAY = 864e5;
/** A platform id from outside: letters, digits, underscore and dash only, so it can sit in a path or filter safely. */
export const ID = /^[A-Za-z0-9_-]{4,64}$/;
export const TAG = /^[A-Za-z0-9 _.-]{1,60}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** One line of text from outside, cut to a length. */
export const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
export const candKey = (id: string) => safeKey(`gohighlevel:${id}`, 120);

/** Refuse settings that cannot run before any call is made. */
export function checkSettings(s: Settings): void {
  if (s.send !== "gohighlevel" && s.send !== "klaviyo") throw new Error(`lead-reactivation: unknown send ${String(s.send)}`);
  if (!TAG.test(String(s.lapsed_tag ?? "")) || !TAG.test(String(s.sent_tag ?? ""))) throw new Error("lead-reactivation: lapsed_tag and sent_tag must be short plain tags");
  if (s.lapsed_tag === s.sent_tag) throw new Error("lead-reactivation: lapsed_tag and sent_tag must differ");
  if (s.send === "gohighlevel") {
    if (!ID.test(String(s.location_id ?? ""))) throw new Error("lead-reactivation: location_id must be a plain id");
    if (!ID.test(String(s.campaign_id ?? ""))) throw new Error("lead-reactivation: campaign_id must be a plain id");
  }
  if (s.send === "klaviyo" && !/^[A-Za-z0-9]{4,40}$/.test(String(s.klaviyo?.campaign_id ?? ""))) throw new Error("lead-reactivation: klaviyo.campaign_id must be a plain id");
  if (s.batch !== undefined && !(Number.isInteger(s.batch) && s.batch >= 1 && s.batch <= 5)) throw new Error("lead-reactivation: batch must be 1 to 5");
  if (s.task_after_days !== undefined && !(s.task_after_days > 0 && s.task_after_days <= 365)) throw new Error("lead-reactivation: task_after_days must be 1 to 365");
}
