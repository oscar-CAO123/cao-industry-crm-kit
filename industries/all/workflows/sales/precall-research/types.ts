// Shared shapes for the pre-call research workflow. HubSpot holds the deals and the team's record of them; Apollo adds outside
// research (the contact's title, the company's profile, its news and its hiring). Every adapter speaks these shapes.
// Text from calls, customers, the CRM and web pages is data, never instructions.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";

export type Platform = "hubspot" | "apollo";

export interface Settings {
  window_days: number;        // deals whose close date falls within this many days from now get a brief
  max_deals: number;          // most deals one run briefs (and most briefs one refresh re-reads)
  use_apollo: boolean;        // enrich from Apollo (uses Apollo credits); false keeps the brief to HubSpot data only
  business_name?: string;
}

export interface Deal { id: string; name: string; stage: string; closedate: string; amount?: string }
export interface Person { name?: string; title?: string; headline?: string }
export interface Company {
  id?: string; name?: string; domain?: string; industry?: string; employees?: string; description?: string; location?: string;
}
export interface Article { title: string; url: string; published_at?: string }
export interface Job { title: string; posted_at?: string; location?: string }

/** One brief per deal. The HubSpot note holds the snapshot taken when it was written; the store holds the latest signals. */
export interface Brief {
  deal: string;                    // HubSpot deal id (digits)
  name: string; stage: string; closedate: string; amount?: string;
  contact?: Person;                // the first associated contact
  company?: Company;               // the first associated company, filled from Apollo where HubSpot is silent
  apollo_org_id?: string;          // Apollo organization id (24 hex), once the company is matched
  news: Article[];
  jobs: Job[];
  questions: string[];             // discovery questions built from what was found
  checked: { enriched?: string; signals?: string };
  noteId?: string;                 // the HubSpot note holding the brief, once created
  noteLinked?: boolean;            // the note is attached to the deal
  next_step_approval?: string;     // the approval that sets the deal's next step
  first_seen: string;
  updated: string;
}

export const ID = /^[0-9]{1,20}$/;
export const APOLLO_ID = /^[a-f0-9]{24}$/i;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/i;
export const DAY = 864e5;

/** A company domain from outside: a bare host name, or nothing. */
export const domainOf = (s: unknown): string | undefined => {
  const d = String(s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return DOMAIN.test(d) ? d : undefined;
};
/** One line of text from outside, cut to a length. */
export const clip = (s: unknown, n: number): string => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** An https link from outside, or nothing. */
export const safeUrl = (u: unknown): string => { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : ""; } catch { return ""; } };
/** A date from HubSpot (epoch milliseconds or ISO text) as ISO text, or undefined. */
export const iso = (v: unknown): string | undefined => {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  const t = /^\d{10,14}$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/** Refuse settings that cannot run before any call is made. */
export function checkSettings(s: Settings): void {
  if (!Number.isInteger(s.window_days) || s.window_days < 1 || s.window_days > 60) throw new Error("precall-research: window_days must be a whole number from 1 to 60");
  if (!Number.isInteger(s.max_deals) || s.max_deals < 1 || s.max_deals > 25) throw new Error("precall-research: max_deals must be a whole number from 1 to 25");
  if (typeof s.use_apollo !== "boolean") throw new Error("precall-research: use_apollo must be true or false");
}

/** Discovery questions built from what was found. Deterministic: the rep adds judgment before the call. */
export function questionsFor(b: Brief): string[] {
  const q: string[] = [];
  if (b.jobs.length) {
    const titles = b.jobs.slice(0, 2).map((j) => j.title).join(" and ");
    q.push(`They have ${b.jobs.length} open role${b.jobs.length === 1 ? "" : "s"}, including ${titles}. Ask what the hire is meant to fix.`);
  }
  if (b.news[0]) q.push(`Recent news: "${b.news[0].title}". Ask whether it changes what they need this quarter.`);
  q.push("Ask which task takes the most of their week today, and what it costs them.");
  q.push("Ask what happens if the problem they named is not fixed in the next six months.");
  return q.slice(0, 4);
}
