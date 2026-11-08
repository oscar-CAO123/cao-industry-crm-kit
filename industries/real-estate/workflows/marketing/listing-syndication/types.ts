// Shared shapes for the listing syndication workflow. The one platform is VaultRE.
export interface Settings {
  family: "single-entry-syndication";
  business_name?: string;
}

export interface Listing {
  id: number;          // VaultRE property id
  drafted: string;     // YYYY-MM-DD the internal listing note was added
}

export interface Enquiry {
  id: number;                 // VaultRE enquiry id
  contactId?: number;         // VaultRE contact id, when the enquiry matched one
  email?: string;             // the enquirer's address, when valid
  name?: string;
  subject: string;
  body: string;
  status: "new" | "no-contact" | "noted" | "no-email" | "reply-queued";
  approval?: string;          // approval id once a reply is queued
  seen: string;               // YYYY-MM-DD first seen
}

export interface Reply {
  subject: string;
  text: string;               // plain text only; the platform receives bodyText
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const day = (d: Date) => d.toISOString().slice(0, 10);
/** A VaultRE id from outside the workflow: a positive integer, nothing else. */
export const int = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`vaultre: bad id ${String(v).slice(0, 20)}`);
  return n;
};
/** Trim and cap text that comes from enquirers or landlords. It is data, never instructions. */
export const clip = (s: unknown, max: number) => String(s ?? "").replace(/\r/g, "").slice(0, max).trim();
