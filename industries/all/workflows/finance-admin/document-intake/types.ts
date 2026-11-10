// Shared shapes for the document-intake workflow. Paths and names come from outside the business (clients, suppliers,
// staff uploads): every one is checked here before it goes into a Dropbox path or a store key.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "dropbox";

export interface Rule { match: string; label: string; folder: string }
/** folder: the business folder a rule files this document into. Only a document filed there counts as holding it. */
export interface ChecklistItem { code: string; label: string; match: string; within_days: number; folder: string }
export interface Settings {
  business_name?: string;
  intake_folder: string;       // where documents land (Dropbox path)
  review_folder: string;       // where documents that match no rule wait for a person
  request_folder: string;      // where a file request sends what the client uploads
  rules: Rule[];               // first rule whose match word appears in the file name wins
  checklist?: ChecklistItem[]; // documents the business must hold; a file request is queued when one is missing
}

export interface Doc {
  key: string; id: string; path: string; name: string; received: string;
  status: "new" | "filed" | "review" | "failed";
  label?: string; from?: string; to?: string; filed_at?: string; error?: string;
}

const SEG = /^[A-Za-z0-9 _().&,'-]{1,120}$/;
/** A Dropbox folder path the business chose: absolute, plain segments, no dot segments. */
export function safePath(p: unknown, what: string): string {
  const s = String(p ?? "");
  const segs = s.split("/").slice(1);
  if (!s.startsWith("/") || s.length > 600 || segs.some((g) => !SEG.test(g) || g === "." || g === "..")) {
    throw new Error(`document-intake: ${what} is not a safe Dropbox folder path`);
  }
  return s.replace(/\/+$/, "");
}

/** A file name safe to reuse in a path: letters, digits, spaces and . _ ( ) - only. */
export const cleanName = (s: string) =>
  s.replace(/[^A-Za-z0-9 ._()-]+/g, "-").replace(/-{2,}/g, "-").replace(/\s{2,}/g, " ").trim().slice(0, 160).replace(/^[ .-]+|[ .]+$/g, "") || "document";

export const keyOf = (s: string) => safeKey(s, 120);
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const DAY = 864e5;
