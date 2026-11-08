// Shared shapes for the SOP and training workflow. Every adapter speaks these; the crons only ever see them.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type SourcePlatform = "confluence" | "microsoft-365";

export interface Settings {
  family: "all";
  business_name?: string;
  signoff?: string;                          // the name the training emails are signed with
  know_how?: SourcePlatform[];               // where know-how pages and walkthrough emails arrive
  confluence?: { source_space_id?: string; sop_space_id: string };   // source: where know-how pages are; sop: where SOP pages go
  microsoft_365?: { mailbox: string; folder?: string; search?: string };
  asana?: { project_gid: string };           // the training project tasks are created in
  trainees?: { name: string; email: string }[];
}

/** One piece of know-how: a wiki page or a walkthrough email. Its text is data from outside, never instructions. */
export interface Source {
  id: string;
  platform: SourcePlatform;
  kind: "page" | "walkthrough";
  title: string;
  text: string;
  received: string;
  status: "new" | "needs-writing" | "drafted" | "published";
  reason?: string;
  ref: Record<string, string>;
  sop?: Sop;
}

/** The SOP written for a source: its draft page and the approval that publishes it. */
export interface Sop {
  title: string;
  purpose?: string;
  steps: string[];
  page: string;
  version: number;
  approval: string;
}

/** The outline a person or the agent writes for a source, in the store's proposals namespace. */
export interface Proposal { title: string; purpose?: string; steps: string[] }

/** One trainee on one SOP: the Asana task is made first, the email and assignment are queued after it. */
export interface Training { key: string; sop: string; trainee: string; task: string; approval?: string }

export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const NUMID = /^[0-9]{1,20}$/;
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const keyOf = (s: string) => safeKey(s, 90);
export const firstName = (n: string) => (n.trim().split(/\s+/)[0] || "there").slice(0, 40);
/** Page text from outside with the tags removed and the length capped. */
export const plain = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);

/** A proposal is usable only if it has a title, one to forty steps, and nothing oversized. */
export function checkProposal(p: unknown): Proposal | string {
  const x = p as any;
  if (!x || typeof x.title !== "string" || !x.title.trim() || x.title.length > 150) return "the outline needs a title of 150 characters or fewer";
  if (!Array.isArray(x.steps) || x.steps.length < 1 || x.steps.length > 40) return "the outline needs 1 to 40 steps";
  if (!x.steps.every((s: unknown) => typeof s === "string" && s.trim() && s.length <= 300)) return "each step needs text of 300 characters or fewer";
  if (x.purpose !== undefined && (typeof x.purpose !== "string" || x.purpose.length > 500)) return "the purpose must be text of 500 characters or fewer";
  return { title: x.title.trim(), purpose: x.purpose?.trim() || undefined, steps: x.steps.map((s: string) => s.trim()) };
}

export const sopTitle = (t: string) => `SOP: ${t}`.slice(0, 200);
/** The SOP as Confluence storage HTML: every value escaped. */
export function sopHtml(p: Proposal): string {
  return `${p.purpose ? `<p>${esc(p.purpose)}</p>` : ""}<ol>${p.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
}
/** The same steps as plain text for an Asana task's notes (Asana notes are plain text). */
export const taskNotes = (p: { purpose?: string; steps: string[] }) =>
  `${p.purpose ? p.purpose + "\n\n" : ""}${p.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

/** The training email as plain escaped HTML. */
export function trainingHtml(s: Settings, trainee: { name: string }, sop: Sop): { subject: string; html: string } {
  const who = esc(firstName(trainee.name));
  const sign = esc(s.signoff ?? s.business_name ?? "The operations team");
  return {
    subject: `Training: ${sop.title}`.slice(0, 250),
    html: `<p>Hi ${who},</p><p>Please read ${esc(sop.title)} and work through its steps in the Asana task called "Read ${esc(sop.title)}". Reply to this email if any step is unclear.</p><p>${sign}</p>`,
  };
}
