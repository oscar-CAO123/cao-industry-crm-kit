// Shared shapes for the seo-visibility workflow. The crons read Ahrefs and save dated reports; a keyword removal waits for approval.

export interface Settings {
  business_name?: string;
  ahrefs: { target: string; project_id: number; country: string; device: "desktop" | "mobile" };
  seed_keywords: string[];
  /** Keywords the owner has agreed to stop tracking. The keywords cron only queues removing those already tracked. */
  retire_keywords?: string[];
  brand_radar?: { report_id?: string; brand?: string; models: string };
}

export interface Report { kind: "rankings" | "keywords" | "backlinks" | "ai-visibility"; day: string; created: string; data: unknown }

export const MODELS = ["chatgpt", "google_ai_overviews", "google_ai_mode", "gemini", "perplexity", "copilot", "claude", "grok", "google_ai_overviews_keywords", "google_ai_mode_keywords"];
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/i;
const COUNTRY = /^[a-z]{2}$/;
const KEYWORD = /^[\p{L}\p{N} '&.-]{1,120}$/u;
const REPORT_ID = /^[A-Za-z0-9_-]{1,120}$/;

/** Returns why the settings cannot run, or null. Every value from settings reaches a request, so each is checked first. */
export function checkSettings(s: Settings): string | null {
  const a = s.ahrefs;
  if (!a || !DOMAIN.test(String(a.target ?? ""))) return "ahrefs.target must be a bare domain such as example.com.au";
  if (!Number.isInteger(a.project_id) || a.project_id <= 0) return "ahrefs.project_id must be the Rank Tracker project number";
  if (!COUNTRY.test(String(a.country ?? ""))) return "ahrefs.country must be a two-letter code such as au";
  if (a.device !== "desktop" && a.device !== "mobile") return "ahrefs.device must be desktop or mobile";
  if (!Array.isArray(s.seed_keywords) || s.seed_keywords.length < 1 || s.seed_keywords.length > 20) return "seed_keywords must hold 1 to 20 keywords";
  if (!s.seed_keywords.every((k) => KEYWORD.test(String(k)))) return "a seed keyword has characters Ahrefs will not take";
  if (s.retire_keywords && !(Array.isArray(s.retire_keywords) && s.retire_keywords.every((k) => KEYWORD.test(String(k))))) return "a retired keyword has characters Ahrefs will not take";
  return null;
}
export function checkBrandRadar(s: Settings): string | null {
  const b = s.brand_radar;
  if (!b?.report_id || !REPORT_ID.test(b.report_id)) return "brand_radar.report_id is missing: create the Brand Radar report in Ahrefs first";
  const models = String(b.models ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (!models.length || !models.every((m) => MODELS.includes(m))) return "brand_radar.models must be a list of the assistants Brand Radar supports";
  return null;
}
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (d: Date, n: number) => day(new Date(d.getTime() - n * 864e5));
export const lower = (s: string) => s.trim().toLowerCase();
