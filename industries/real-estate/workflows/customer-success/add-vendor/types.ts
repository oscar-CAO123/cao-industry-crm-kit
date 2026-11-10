// Shared shapes for the vendor report workflow. Each adapter speaks these, so a cron never depends on one vendor's fields.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "vaultre" | "rex" | "microsoft-365";

export interface Vendor { property_id: number; name?: string; email: string }
export interface Settings {
  business_name?: string;
  vendors: Vendor[];                       // the listings this business reports on, each with the vendor to send to
  platform?: "vaultre" | "rex";            // which system holds the listings (default vaultre); property_id is that system's listing id
  vaultre?: { open_home_days?: number };   // how many days of open homes the report covers
  microsoft_365: { mailbox: string };      // the mailbox the report is drafted and sent from
}

export interface OpenHome { id: number; start: string; end: string }
/** What the pull cron read for one listing. */
export interface PropertyFigures {
  property_id: number; sale_life_id: number; heading: string; address: string; price: string;
  open_homes: OpenHome[]; as_of: string;
  /** false when the platform could not read open homes: the report then leaves the open home section out, never says there were none. */
  open_homes_known?: boolean;
}
/** One listing's report for one day. */
export interface Report {
  key: string; property_id: number; date: string; to: string; subject: string;
  status: "needs-figures" | "needs-commentary" | "needs-check" | "draft-made" | "drafted";
  message_id?: string; created: string; reason?: string;
}
export interface Commentary { text: string; written: string }

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
export const reportKey = (propertyId: number, date: string) => safeKey(`${propertyId}:${date}`);

/** The vendor's email body: escaped throughout, commentary as paragraphs, then the open homes in the window. */
export function reportHtml(s: Settings, f: PropertyFigures, commentary: string, v: Vendor): string {
  const days = s.vaultre?.open_home_days ?? 7;
  const paras = String(commentary).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const homes = f.open_homes.length
    ? `<ul>${f.open_homes.map((h) => `<li>${esc(h.start)}${h.end ? ` to ${esc(h.end)}` : ""}</li>`).join("")}</ul>`
    : "<p>No open homes in this period.</p>";
  const homeBlock = f.open_homes_known === false ? "" : `<p>Open homes in the last ${esc(days)} days: ${esc(f.open_homes.length)}</p>${homes}`;
  return `<p>Hi ${esc(v.name ?? "there")},</p>${paras}`
    + `<p><b>${esc(f.heading || f.address)}</b>${f.price ? ` (${esc(f.price)})` : ""}</p>`
    + homeBlock
    + `<p>${esc(s.business_name ?? "")}</p>`;
}
