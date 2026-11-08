// Shared shapes for the add-mask workflow. Paths, file ids and email addresses come from outside the business
// (Dropbox listings, the owner's settings): each one is checked here before it goes into a Dropbox call or a store key.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "dropbox";

export interface Recipient { email: string; label?: string }
export interface Settings {
  business_name?: string;
  owner_email?: string;      // the business's own account: check never flags it
  raw_folder: string;        // where client documents arrive before masking (Dropbox path)
  masked_folder: string;     // where a person puts a copy after masking and checking it (Dropbox path)
  recipients: Recipient[];   // the only people a masked copy may be shared with
}

export interface RawFile { key: string; id: string; path: string; name: string; seen: string; status: "new" }
export interface MaskedFile { key: string; id: string; path: string; name: string; seen: string; members: string[]; unexpected: string[] }

const SEG = /^[A-Za-z0-9 _().&,'-]{1,120}$/;
/** A Dropbox folder path the business chose: absolute, plain segments, no dot segments. */
export function safePath(p: unknown, what: string): string {
  const s = String(p ?? "");
  const segs = s.split("/").slice(1);
  if (!s.startsWith("/") || s.length > 600 || segs.some((g) => !SEG.test(g) || g === "." || g === "..")) {
    throw new Error(`add-mask: ${what} is not a safe Dropbox folder path`);
  }
  return s.replace(/\/+$/, "");
}

const FILE_ID = /^id:[A-Za-z0-9_-]{1,120}$/;
/** A Dropbox file id taken from a listing, or undefined when it does not have the id form. */
export const fileId = (s: unknown): string | undefined => (FILE_ID.test(String(s ?? "")) ? String(s) : undefined);

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** An email address the business configured, lower-cased. Throws when it is malformed. */
export function safeEmail(s: unknown, what: string): string {
  const e = String(s ?? "").trim();
  if (!EMAIL.test(e)) throw new Error(`add-mask: ${what} is not a valid email address`);
  return e.toLowerCase();
}

export const keyOf = (s: string) => safeKey(s, 120);
