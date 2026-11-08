// Shared shapes for the litigation drafting workflow. The crons read matters and files, write internal memos and tasks,
// and queue any message to a client for approval. Judgment (the pleading matrix, the defence, case law) is written
// into the store as a Draft by the agent skill in SKILL.md; the crons never invent legal content.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "smokeball";

export interface Settings {
  family: "commercial-litigation";
  platform: Platform;                 // the case-management system that holds matters, files and memos
  solicitor_staff_id: string;         // the staff id that receives review tasks
  practice_name?: string;
  lead_matter_type_id?: string;       // optional: only pick up lead matters of this matter type
}

export interface Matter {
  id: string;
  number?: string;
  title: string;
  status?: string;
  clients: string[];                  // client contact ids, used to address a portal message
  stage?: "new" | "reviewing";        // where the matter sits in this workflow
  files_seen?: number;                // file count at the last inventory memo
  seen: string;
}

export interface FileRecord { id: string; name: string; ext?: string; created?: string; modified?: string; size?: number }

export interface Draft {
  key: string;
  matter: string;                     // matter id
  title: string;                      // memo title, for example "Draft defence v1"
  text: string;                       // the memo body (plain text)
  client_message?: string;            // optional portal message for the client to admit, deny or comment (queued, never sent)
  status: "pending" | "memo-written" | "done" | "no-contact";
  created: string;
}

export const ID = /^[A-Za-z0-9-]{1,64}$/;
export const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, max);
export const keyOf = (s: string) => safeKey(s, 90);
