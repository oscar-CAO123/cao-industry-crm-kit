// Shared shapes for the client selections workflow. The register sheet is the source: the client's form answers land in it,
// and the crons read it and draft from it. Nothing here writes to the sheet.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export const SHEET_ID = /^[A-Za-z0-9_-]{20,120}$/;
export const RANGE = /^[A-Za-z0-9 _'!:$.-]{1,80}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const DAY = 864e5;

/** Column headers the register must carry, in row 1 of the range. */
export const HEADERS = ["Project", "Client", "Email", "Selection", "Allowance", "Chosen", "Status", "Due"] as const;
export const STATUSES = ["pack-ready", "awaiting-choice", "chosen"] as const;

export interface Settings {
  business_name?: string;
  google?: {
    spreadsheet_id: string;      // the register sheet, validated before any call
    register_range: string;      // sheet and range holding the register, header row first
  };
  selections?: {
    form_url: string;            // https link to the client's selection form (the one that writes to the register)
    followup_after_days?: number;
    chase_every_days?: number;
    max_chases?: number;
    signoff?: string;
  };
}

/** One register row as the owner or the client's form left it. */
export interface SelectionRow {
  project: string; client: string; email: string; selection: string; allowance: string; chosen: string;
  status: (typeof STATUSES)[number] | "other"; due: string;
}

/** What the workflow keeps per row: the latest row, and the state of the pack and chases. */
export interface SelectionState {
  key: string;
  row: SelectionRow;
  seen: string;
  pack_draft?: string;           // Gmail draft id of the pack, kept so a rerun never drafts it twice
  pack_queued?: boolean;
  chases: string[];              // ISO times of chases queued
  reason?: string;
}

export const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
export const keyOf = (project: string, client: string, selection: string) => safeKey(`sel:${slug(project)}:${slug(client)}:${slug(selection)}`, 120);
export const dueLabel = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "the date we agreed");
