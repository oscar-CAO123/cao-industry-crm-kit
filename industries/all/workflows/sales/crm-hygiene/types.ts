// Shared shapes for the CRM hygiene workflow. Both adapters speak these, so the crons do not care which CRM holds the records.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "hubspot" | "pipedrive";
export interface Settings {
  crm: Platform;                          // where the records live
  read_limit: number;                     // most records one scan reads; a longer list is cut short and the next scan starts again
  fix_email_case: boolean;                // queue a trim and lowercase of email addresses that need it
}

/** A contact or person as the scan reads it. emails are the addresses as the CRM holds them, created orders the records. */
export interface Contact { id: string; emails: string[]; created: string }

export type Kind = "duplicate" | "email-tidy";
/** One line of the register. The register lives in the workflow store; the CRM changes only when a queued approval runs. */
export interface Finding {
  key: string;
  platform: Platform;
  kind: Kind;
  id: string;                             // the record the change applies to (a duplicate: the record merged away)
  with?: string;                          // duplicate only: the record kept
  summary: string;
  status: "open" | "queued" | "resolved";
  first_seen: string;
  seen_at: string;
  approval?: string;                      // the approval id once the change is queued
}

export interface Adapter {
  id: Platform;
  /** One page of records that hold an email address. next is the cursor for the following page, when there is one. */
  page(ctx: Ctx<Settings>, cursor?: string): Promise<{ items: Contact[]; next?: string }>;
  /** Queue the merge of a duplicate into the record kept. */
  queueMerge(ctx: Ctx<Settings>, f: Finding, key: string): Promise<string>;
  /** Re-read the record and queue its email tidy when it still needs one. Returns undefined when nothing needs changing. */
  queueTidy(ctx: Ctx<Settings>, f: Finding, key: string): Promise<string | undefined>;
}

/** A platform record id from outside: digits only, so it can sit in a path or a body safely. */
export const ID = /^[0-9]{1,20}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
export const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
export const valid = (s: string) => s.length <= 254 && EMAIL.test(s);
/** The tidied form of an address: trimmed and lowercased when that makes it a valid address, otherwise left as it is. */
export const tidy = (s: unknown): string => { const n = norm(s); return valid(n) ? n : String(s ?? ""); };
/** Oldest first; a record with no creation date sorts last, then by id. */
export const byOldest = (a: Contact, b: Contact) => (a.created || "~").localeCompare(b.created || "~") || Number(a.id) - Number(b.id);
/** One line of text from outside, cut to a length. */
export const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** Refuse settings that cannot run before any call is made. */
export function checkSettings(s: Settings): void {
  if (s.crm !== "hubspot" && s.crm !== "pipedrive") throw new Error(`crm-hygiene: unknown crm ${String(s.crm)}`);
  if (!Number.isInteger(s.read_limit) || s.read_limit < 1 || s.read_limit > 10000) throw new Error("crm-hygiene: read_limit must be a whole number from 1 to 10000");
  if (typeof s.fix_email_case !== "boolean") throw new Error("crm-hygiene: fix_email_case must be true or false");
}
