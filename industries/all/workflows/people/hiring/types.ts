// Shared shapes for the hiring workflow. The adapter speaks these; the crons only ever see them.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "microsoft-365";

export interface Settings {
  business_name?: string;
  signoff?: string;                  // the name the emails are signed with
  microsoft_365?: {
    mailbox: string;                 // the business's own mailbox that receives applications
    folder?: string;                 // mail folder to read, default inbox
    search?: string;                 // words an application email contains, default "application"
    register?: { drive: string; item: string; table: string };  // Excel candidate register: Date | Applicant | Email | Role | Source | Status
  };
}

/** Where an applicant is in the process. Only the cron moves it, and only after its draft is queued. */
export type Stage = "new" | "acknowledged" | "invited" | "declined";

export interface Applicant {
  id: string;
  source: Platform;
  name: string;
  email?: string;
  role: string;
  text: string;                      // the body preview of the application email, capped
  received: string;
  stage: Stage;
  /** Set by the owner (in the CRM shell or the store), never by a cron: "interview" or "decline". */
  decision?: "interview" | "decline";
  ref: Record<string, string>;
}

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** A spreadsheet cell that can never become a formula. */
export const cell = (v: unknown) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
export const keyOf = (s: string) => safeKey(s, 90);
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const firstName = (n: string) => (n.trim().split(/\s+/)[0] || "there").slice(0, 40);

/** The email for a stage change, as plain escaped HTML. Human copy: no templates with blanks left in. */
export function letterHtml(s: Settings, kind: "ack" | "invite" | "decline", a: Applicant): { subject: string; html: string } {
  const who = esc(firstName(a.name));
  const role = esc(a.role || "the role");
  const sign = esc(s.signoff ?? s.business_name ?? "The hiring team");
  if (kind === "ack") return {
    subject: `Your application for ${a.role || "the role"}`,
    html: `<p>Hi ${who},</p><p>Thanks for applying for ${role}. We have your application and we are reading through every one.</p><p>If we would like to talk, we will be in touch directly.</p><p>${sign}</p>`,
  };
  if (kind === "invite") return {
    subject: `Next step for ${a.role || "the role"}`,
    html: `<p>Hi ${who},</p><p>Thanks for your application for ${role}. We would like to speak with you. Reply to this email with two or three times that suit you this week.</p><p>${sign}</p>`,
  };
  return {
    subject: `Your application for ${a.role || "the role"}`,
    html: `<p>Hi ${who},</p><p>Thanks for applying for ${role} and for the time you put into your application. We have decided not to go ahead with it this time, and we wish you well in your search.</p><p>${sign}</p>`,
  };
}
