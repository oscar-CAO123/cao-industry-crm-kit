// Shared shapes for the customer research workflow. Helpers come from the quoting reference (cell, esc, EMAIL), which is read-only here.
import { createHash } from "node:crypto";
import { EMAIL, esc, cell } from "../../../../../industries/construction/workflows/sales/quoting/types.ts";

export { EMAIL, esc, cell };

export type Source = "google-forms" | "calendly";

export interface Settings {
  business_name?: string;
  /** The client's own address. The summary draft is written here, never sent. */
  owner_email: string;
  survey: {
    source: Source;
    /** google-forms: the Form id from its edit link. */
    google_form_id?: string;
    /** calendly: the routing form URI, for example https://api.calendly.com/routing_forms/XXXX. */
    calendly_form_uri?: string;
    /** The public link the invite asks people to open. Set by the owner. */
    survey_url: string;
  };
  /** Optional internal log: one row per response. Needs the Google Workspace adapter. */
  research_log?: { spreadsheet_id: string; sheet?: string };
  invite: {
    subject?: string;
    /** The customers the owner has chosen. The workflow never picks them from a platform. */
    audience: { name?: string; email: string }[];
  };
}

export interface Answer { question: string; answer: string }

/** A survey response, normalised across sources. The key is a hash of the source id, so the store never holds the raw id. */
export interface Response {
  key: string;
  source: Source;
  received: string;
  email?: string;
  answers: Answer[];
}

export const keyFor = (prefix: string, s: string) => `${prefix}-${createHash("sha256").update(s).digest("hex").slice(0, 40)}`;

const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]*)?$/;
const GOOGLE_FORM_ID = /^[A-Za-z0-9_-]{10,120}$/;
const CALENDLY_FORM = /^https:\/\/api\.calendly\.com\/routing_forms\/[A-Za-z0-9-]{4,80}$/;
const SHEET_ID = /^[A-Za-z0-9_-]{20,120}$/;
const SHEET_NAME = /^[A-Za-z0-9 _-]{1,60}$/;

/** Refuses a bad setting before any network call. */
export function checkSettings(s: Settings): void {
  if (!EMAIL.test(s.owner_email ?? "")) throw new Error("customer-research: owner_email is not set");
  if (!s.survey || !HTTPS_URL.test(s.survey.survey_url ?? "") || s.survey.survey_url.length > 300) throw new Error("customer-research: survey.survey_url must be an https link");
  if (s.survey.source === "google-forms") {
    if (!GOOGLE_FORM_ID.test(s.survey.google_form_id ?? "")) throw new Error("customer-research: survey.google_form_id is not set or not valid");
  } else if (s.survey.source === "calendly") {
    if (!CALENDLY_FORM.test(s.survey.calendly_form_uri ?? "")) throw new Error("customer-research: survey.calendly_form_uri is not valid");
  } else throw new Error("customer-research: survey.source must be google-forms or calendly");
  if (s.research_log && (!SHEET_ID.test(s.research_log.spreadsheet_id ?? "") || (s.research_log.sheet && !SHEET_NAME.test(s.research_log.sheet)))) throw new Error("customer-research: research_log is not valid");
  for (const c of s.invite?.audience ?? []) if (!EMAIL.test(c.email ?? "")) throw new Error("customer-research: an invite audience email is not valid");
}

export const sheetName = (s: Settings) => s.research_log?.sheet ?? "Responses";
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const firstName = (n?: string) => (n ?? "").trim().split(/\s+/)[0] ?? "";
export const GMAIL_ID = /^[A-Za-z0-9_-]{4,200}$/;
