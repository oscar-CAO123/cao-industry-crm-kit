// Shared shapes for the automotive vehicle-listing workflow. The stock register and the listing register are Excel tables
// in the business's own workbook; photos are a folder in OneDrive; copy and checklists go out through the business's
// mailbox (Microsoft 365). Nothing is published to a listing site by this workflow.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365";

export interface Table { drive: string; item: string; table: string }

export interface Settings {
  business_name?: string;
  microsoft_365: { mailbox: string; folder?: string; stock: Table; register?: Table; photos: { drive: string } };
  listing_to: string;      // the listing desk: receives each listing copy for approval, then pastes it into the listing sites
  transfer_to?: string;    // the transfer desk: receives an ownership transfer checklist for approval (no buyer details)
  min_photos?: number;     // photos needed before a vehicle is ready to list (default 6)
}

/** Written by the agent (see SKILL.md). The description is the listing copy; sold marks the vehicle as sold. */
export interface Proposal {
  description: string;
  sold?: boolean;
  note?: string;
}

export interface Vehicle {
  id: string;
  stock: string;
  title: string;
  price: number;
  photo_folder: string;     // a OneDrive folder id from the stock register
  sheet_status: string;     // the Status cell in the stock register, refreshed on every intake run
  status: "new" | "needs-photos" | "ready" | "drafted" | "listed" | "transfer-drafted" | "transferred";
  photos?: number;
  reason?: string;
  seen: string;
  message_id?: string;
  approval?: string;        // approval id of the listing-copy send
  listed_at?: string;
  transfer?: string;        // approval id of the transfer checklist send
}

export const ID = /^[A-Za-z0-9=_\-!.]{1,400}$/;
export const STOCK = /^[A-Za-z0-9._-]{1,40}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const cap = (s: string, n: number) => String(s ?? "").slice(0, n);
/** Listing copy as escaped paragraphs: one <p> per blank-line-separated block. */
export const paragraphs = (t: string) => t.trim().slice(0, 4000).split(/\n\s*\n|\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p)}</p>`).join("");
export type Cx = Ctx<Settings>;
