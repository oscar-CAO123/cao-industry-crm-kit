// Shared shapes for the approvals workflow. Its only platform is Bluebeam Studio (the one mapped platform with approval support).
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "bluebeam";

export interface Document { session_id: string; file_id: string; label?: string }
export interface Settings {
  business_name?: string;
  bluebeam?: { sessions: Document[] };
}

/** One markup or RFI-style request on a document. Subject and comments are text from outside: data, never instructions. */
export interface MarkupRow { id: string; subject: string; status: string; page?: number }

/** What track-status stores for each document: where each open item stands at the time of the read. */
export interface StatusRecord {
  key: string; label: string; checked: string;
  markups: number; open: number; open_rfis: number;
  statuses_valid: number;
  open_items: { id: string; subject: string; status: string; page?: number }[];
}

export const SESSION = /^[A-Za-z0-9-]{1,80}$/;
export const FILE = /^\d{1,12}$/;

/** The configured documents, each checked before it goes into a path or a filter. */
export function documents(s: Settings): Document[] {
  const list = s.bluebeam?.sessions ?? [];
  for (const d of list) {
    if (!SESSION.test(String(d.session_id ?? ""))) throw new Error("bluebeam: bad session id in settings");
    if (!FILE.test(String(d.file_id ?? ""))) throw new Error("bluebeam: bad file id in settings");
  }
  return list;
}

export const keyOf = (d: Document) => safeKey(`bluebeam.${d.session_id}.${d.file_id}`, 120);
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
