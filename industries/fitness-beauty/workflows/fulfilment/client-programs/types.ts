// Shared shapes for the client programs workflow. Airtable holds clients, programs, sessions and progress; Gmail holds check-in drafts.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "airtable" | "google-workspace";

export interface Settings {
  business_name?: string;
  airtable: {
    base_id: string;
    tables: { clients: string; programs: string; sessions: string; progress: string };
    fields: {
      clients: { name: string; email: string; goal: string; status: string; sessions: string };
      programs: { client: string; name: string; plan: string; status: string };
      sessions: { client: string; date: string; notes: string };
      progress: { client: string; week: string; summary: string };
    };
  };
  statuses: { intake_done: string; program_drafted: string; active: string };
  program_templates?: { match: string; name: string; plan: string }[];
  check_in?: { after_days: number; subject: string; body: string };
}

/** One Airtable row as the REST API returns it: a record id and cell values keyed by field name. */
export interface AtRecord { id: string; createdTime?: string; fields: Record<string, any> }

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const BASE_ID = /^app[A-Za-z0-9]{14}$/;
export const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
export const TABLE = /^[A-Za-z0-9 _-]{1,100}$/;
export const DAY = 864e5;
export const WEEK = 7 * DAY;
