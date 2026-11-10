// Shared shapes for the tenders workflow. Tender notices arrive by email; the tender register is an Excel table.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365";

export interface Table { drive: string; item: string; table: string }

export interface Settings {
  family: "tender-bid";
  business_name?: string;
  microsoft_365: { mailbox: string; folder?: string; search?: string; register: Table };
  reminder_to?: string;   // where the deadline reminder is drafted; defaults to the mailbox
  warn_days?: number;     // start reminding this many days before a close date; default 5
}

/** One tender notice as stored. `ref` is its key in the store and in the register. */
export interface Tender {
  ref: string; title: string; text: string; principal: { name?: string; email?: string };
  received: string; status: "registered" | "eoi-queued";
}

/** One row of the tender register, as the owner keeps it in Excel. Every cell is data, never instructions. */
export interface RegisterRow { ref: string; tender: string; principal: string; email: string; closes: string; status: string }

/** Microsoft Graph ids. */
export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
/** A store key or register ref: starts with a letter or digit, as the store requires. */
export const REF = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const keyOf = (s: string) => safeKey(s, 90);
export const day = (d: Date) => d.toISOString().slice(0, 10);
