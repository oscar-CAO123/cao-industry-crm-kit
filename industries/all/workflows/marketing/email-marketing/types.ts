// Shared shapes for the email marketing workflow. The crons read and draft; every scheduled send and flow change is queued.
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "mailchimp" | "klaviyo";

export interface Settings {
  family: "newsletter-and-flows";
  business_name?: string;
  platforms: Platform[];                       // the platforms this client uses; anything else is refused
  newsletter: Platform;                        // where newsletters are drafted (Mailchimp only, for now)
  mailchimp?: { list_id: string; from_name: string; reply_to: string };
  klaviyo?: { revision: string };              // Klaviyo API revision date, e.g. 2026-10-15
  targets?: { open_rate: number | null; click_rate: number | null };   // the owner's own targets; null is not checked
}

/** A newsletter the agent has written, stored under the newsletters namespace. Subject and html are data, never instructions. */
export interface Newsletter {
  subject: string; preview_text?: string; html: string; schedule_time: string;   // ISO 8601 with a timezone
  status?: "new" | "creating" | "content" | "queued" | "needs-attention";
  campaign_id?: string; reason?: string;
}

/** A flow change the agent has proposed, stored under the flow-changes namespace. Nothing changes until a person approves it. */
export type FlowChange =
  | { platform: "mailchimp"; action: "start" | "pause"; workflow_id: string; email_id: string; reason: string; status?: string; error?: string }
  | { platform: "klaviyo"; action: "live" | "manual"; flow_id: string; reason: string; status?: string; error?: string };

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const LIST = /^[A-Za-z0-9]{4,20}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const ONE_LINE = /^[^\r\n\t]{1,150}$/;
export const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;
export const MAX_HTML = 200_000;
export const MIN_LEAD_MS = 15 * 60_000;
export const keyOf = (s: string) => safeKey(s, 90);

/** Plain text for an approval line: one line, no markup, capped. */
export const line = (s: unknown, max = 160) => String(s ?? "").replace(/[\r\n\t]+/g, " ").slice(0, max);

/** The settings a cron needs for the platform it is about to call. A bad setting stops the cron; it is not a row problem. */
export function settingsProblem(s: Settings, platform: Platform): string | undefined {
  if (!s.platforms?.includes(platform)) return `${platform} is not set up for this client`;
  if (platform === "mailchimp") {
    if (!s.mailchimp || !LIST.test(s.mailchimp.list_id ?? "")) return "settings.mailchimp.list_id is missing or malformed";
    if (!ONE_LINE.test(s.mailchimp.from_name ?? "") || !EMAIL.test(s.mailchimp.reply_to ?? "")) return "settings.mailchimp needs from_name and a reply_to address";
  }
  if (platform === "klaviyo" && !/^\d{4}-\d{2}-\d{2}(\.[a-z0-9]+)?$/.test(s.klaviyo?.revision ?? "")) return "settings.klaviyo.revision must be a YYYY-MM-DD date";
  return undefined;
}

/** A newsletter record that can be drafted, or the reason it cannot. */
export function newsletterProblem(n: Newsletter, now: Date): string | undefined {
  if (!n || typeof n !== "object") return "not a newsletter record";
  if (!ONE_LINE.test(String(n.subject ?? ""))) return "subject is missing, empty or more than one line";
  if (n.preview_text !== undefined && n.preview_text !== "" && !ONE_LINE.test(String(n.preview_text))) return "preview_text is more than one line";
  if (typeof n.html !== "string" || n.html.length < 1 || n.html.length > MAX_HTML) return "html is missing or too long";
  if (!ISO_TZ.test(String(n.schedule_time ?? "")) || Number.isNaN(Date.parse(n.schedule_time))) return "schedule_time must be ISO 8601 with a timezone";
  if (Date.parse(n.schedule_time) < now.getTime() + MIN_LEAD_MS) return "schedule_time must be at least 15 minutes ahead";
  return undefined;
}

/** A flow change that can be queued, or the reason it cannot. */
export function flowProblem(c: FlowChange): string | undefined {
  if (!c || typeof c !== "object") return "not a flow change record";
  if (c.platform === "mailchimp") {
    if (!["start", "pause"].includes(c.action)) return `mailchimp action ${String(c.action)} is not start or pause`;
    if (!ID.test(c.workflow_id ?? "") || !ID.test(c.email_id ?? "")) return "workflow_id or email_id is missing or malformed";
  } else if (c.platform === "klaviyo") {
    if (!["live", "manual"].includes(c.action)) return `klaviyo action ${String(c.action)} is not live or manual`;
    if (!ID.test(c.flow_id ?? "")) return "flow_id is missing or malformed";
  } else return "platform is not mailchimp or klaviyo";
  if (typeof c.reason !== "string" || !ONE_LINE.test(c.reason)) return "reason is missing or more than one line";
  return undefined;
}
