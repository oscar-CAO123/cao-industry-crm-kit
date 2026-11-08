// Shared shapes for the automotive deal-structuring workflow. Deals live in the CRM (Pipedrive); lender packs and the
// deal register go through the business's mailbox and workbook (Microsoft 365).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "pipedrive" | "microsoft-365";

export interface Lender { id: string; name: string; submit_to: string }

export interface Settings {
  business_name?: string;
  pipedrive: { pipeline_id: number; intake_stage_id: number; submitted_stage_id: number };
  microsoft_365: { mailbox: string; folder?: string; search?: string; register?: { drive: string; item: string; table: string } };
  lenders: Lender[];
  max_lenders_per_deal?: number;
  follow_up?: { after_days: number[] };
}

/** Written by the agent (see SKILL.md) once the credit application is complete and consent is on file. */
export interface Proposal {
  lenders: string[];          // lender ids from settings, in the order to submit
  credit_ready: boolean;      // set only after a person or the agent has checked the application
  amount_financed?: number;
  term_months?: number;
  note?: string;
}

export interface Deal {
  id: string; title: string; value?: number; currency?: string; person_id?: number; org_id?: number;
  status: "new" | "packed" | "submitted";
  seen: string;
  reason?: string;
  packs?: Record<string, { message_id: string; approval: string }>;
  noted?: boolean;
  submitted_to?: string; submitted_at?: string;
  decided?: string;            // written by a person or the agent when a lender answers; chasing stops
  followups?: string[];
}

export const DAY = 864e5;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const cap = (s: string, n: number) => String(s ?? "").slice(0, n);
export type Cx = Ctx<Settings>;
