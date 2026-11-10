// Shapes for the ad-campaigns workflow. The one platform this job maps in the kit for a full campaign is Meta (Facebook ads).
// Every create is a live operation: a cron only queues it, and a person approves it. Every object is created PAUSED, so
// nothing spends until someone switches it on in Ads Manager, which this workflow never does.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Objective = "OUTCOME_LEADS" | "OUTCOME_TRAFFIC";
export type Step = "campaign" | "adset" | "creative" | "ad";
export const STEPS: Step[] = ["campaign", "adset", "creative", "ad"];

export interface Settings {
  business_name?: string;
  meta: { ad_account_id?: string; page_id?: string };  // "act_<digits>" and the Facebook Page the ads run from
  countries?: string[];                                  // ISO 3166 alpha-2 codes the ad sets target (default ["AU"])
  max_daily_budget_minor?: number;                       // the most a plan may spend per day, in minor units (default 50000)
  plan_limit_per_run?: number;                           // most plans one run works on (default 5)
}

/** A campaign the owner or the agent has planned. Written to the `campaigns` namespace. The crons never write its copy. */
export interface CampaignPlan {
  id: string;
  name: string;
  objective: Objective;
  daily_budget_minor: number;                // whole number of cents (minor units of the ad account currency)
  age_min?: number;                          // 18 to 65 (default 18)
  age_max?: number;                          // 18 to 65 (default 65)
  image_url: string;                         // https picture Meta fetches itself
  link: string;                              // https landing page
  headline: string;
  message: string;
  lead_gen_form_id?: string;                 // required for OUTCOME_LEADS
  status: "planned" | "ready" | "building" | "built" | "skipped" | "blocked" | "rejected";
  reason?: string;
  ids?: Partial<Record<Step, string>>;       // Meta ids, once each create step has completed
  approvals?: Partial<Record<Step, string>>; // approval ids, once queued: a step is never queued twice
}

export const POST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const NUM = /^\d{1,25}$/;
const AD_ACCOUNT = /^act_\d{1,25}$/;
const COUNTRY = /^[A-Z]{2}$/;
export const keyOf = (s: string) => safeKey(s, 90);

/** Why the client's settings cannot run this job, or null when they can. */
export function setupProblem(s: Settings): string | null {
  if (!AD_ACCOUNT.test(s.meta?.ad_account_id ?? "")) return "settings.meta.ad_account_id must look like act_<digits>";
  if (!NUM.test(s.meta?.page_id ?? "")) return "settings.meta.page_id is not set";
  const countries = s.countries ?? ["AU"];
  if (!Array.isArray(countries) || !countries.length || !countries.every((c) => COUNTRY.test(c))) return "settings.countries must be two-letter country codes";
  return null;
}

/** A link Meta can fetch: https only, no credentials in the URL. */
export function httpsOk(u: string): boolean {
  if (u.length > 2000) return false;
  try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password; } catch { return false; }
}

/** Why a plan cannot run, or null when it can. Checked before any call. These are this workflow's own bounds, not Meta's. */
export function planProblem(p: CampaignPlan, s: Settings): string | null {
  if (!POST_ID.test(String(p.id ?? ""))) return "plan id must be 1 to 80 letters, digits, dashes or underscores";
  const name = String(p.name ?? "").trim();
  if (!name || name.length > 100) return "name must be 1 to 100 characters";
  if (p.objective !== "OUTCOME_LEADS" && p.objective !== "OUTCOME_TRAFFIC") return "objective must be OUTCOME_LEADS or OUTCOME_TRAFFIC";
  const max = s.max_daily_budget_minor ?? 50000;
  if (!Number.isInteger(p.daily_budget_minor) || p.daily_budget_minor < 100 || p.daily_budget_minor > max) return `daily_budget_minor must be a whole number from 100 to ${max}`;
  const lo = p.age_min ?? 18, hi = p.age_max ?? 65;
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 18 || hi > 65 || lo > hi) return "the age range must be whole numbers from 18 to 65, low first";
  if (!httpsOk(String(p.image_url ?? ""))) return "image_url must be an https link with no login in it";
  if (!httpsOk(String(p.link ?? ""))) return "link must be an https link with no login in it";
  const headline = String(p.headline ?? "").trim();
  if (!headline || headline.length > 100) return "headline must be 1 to 100 characters";
  const message = String(p.message ?? "").trim();
  if (!message || message.length > 2200) return "message must be 1 to 2200 characters";
  if (p.objective === "OUTCOME_LEADS" && !NUM.test(String(p.lead_gen_form_id ?? ""))) return "a lead campaign needs lead_gen_form_id";
  return null;
}
