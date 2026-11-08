// Shared shapes for the contracts e-signature workflow. The one platform here is DocuSign.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "docusign";

export interface Settings {
  business_name?: string;
  email_subject_prefix?: string;   // the subject starts with this, then the agreement title
  status_check_limit?: number;     // most envelopes read back from DocuSign in one status run
}

export interface Signer { name: string; email: string }

export type Status = "new" | "needs-check" | "drafted" | "awaiting-approval" | "sent" | "delivered" | "signed" | "completed" | "declined" | "voided";

export interface Agreement {
  id: string;
  title: string;
  signers: Signer[];                          // signed in this order: signer 1 first
  document: { name: string; base64: string }; // a PDF, base64 encoded
  status: Status;
  reason?: string;
  envelope?: string;                          // DocuSign envelope id once drafted
  approval?: string;                          // the queued send, once queued
  created: string;
  sent_at?: string;
  completed_at?: string;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const keyOf = (s: string) => safeKey(s, 120);

/** Plain text from outside the kit: control characters removed, trimmed, cut to a length. */
export const cleanText = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

/** Checks an agreement record before any envelope is drafted. Returns the reason it is held, or null when it is fine. */
export function checkAgreement(a: Agreement): string | null {
  if (!ID.test(String(a.id ?? ""))) return "agreement id is not a plain id";
  if (!cleanText(a.title, 120)) return "agreement has no title";
  if (!Array.isArray(a.signers) || a.signers.length < 1 || a.signers.length > 10) return "needs 1 to 10 signers";
  for (const s of a.signers) {
    if (!cleanText(s?.name, 100)) return "a signer has no name";
    if (!EMAIL.test(String(s?.email ?? ""))) return "a signer email is not valid";
  }
  if (!cleanText(a.document?.name, 100)) return "document has no name";
  const b64 = String(a.document?.base64 ?? "").replace(/\s/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return "document is not base64";
  if (Math.floor((b64.length * 3) / 4) > MAX_PDF_BYTES) return "document is over 10 MB";
  if (Buffer.from(b64, "base64").subarray(0, 4).toString("latin1") !== "%PDF") return "document is not a PDF";
  return null;
}
