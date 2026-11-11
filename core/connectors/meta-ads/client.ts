import { composioEnabled } from "../../lib/connection-provider.ts";
// Meta helper: ad insights, lead form leads, and conversion events back to the pixel.
// Keys: META_ADS_TOKEN (a system user token that can read the ad account), META_PAGE_TOKEN (a page
// token, needed for lead forms), META_PIXEL_ID for conversions.
// The ads token can spend money, so nothing here creates, edits or starts an ad. The only write is
// sending conversion events, and that needs KIT_ALLOW_WRITES=1.
//
// Source of each function, from the reference CRM at commit 28aa5d91 unless marked NEW:
//   insights, timeParams, leadCount, totals   scripts/crm-meta-ads.ts insights and scripts/lib-meta-insights.ts (aggregateRows)
//   listLeadForms, listLeads          scripts/crm-meta-leadform-sync.ts (forms, then leads since a time)
//   sendConversions, userData         scripts/crm-meta-crm-events.ts, with its inactive-test-code stop
// Changed on purpose: the CRM puts the key in the URL and follows paging links that carry it. The
// kit sends the key in a header and strips any key from a paging link, so a saved link never holds one.

import crypto from "node:crypto";
import { call, checkUrl, type AppSpec } from "../../lib/http.ts";
import { secret } from "../../lib/secrets.ts";
import { collect } from "../../lib/paging.ts";

export const spec: AppSpec = { app: "meta-ads", hosts: ["graph.facebook.com"] };
const API = "https://graph.facebook.com/v21.0";

const bearer = (name: "META_ADS_TOKEN" | "META_PAGE_TOKEN") => composioEnabled("meta-ads") ? {} : ({ Authorization: `Bearer ${secret(name)}` });

/** A paging link without any key in it. */
export function cleanNext(next: string | undefined | null): string | null {
  if (!next) return null;
  const u = new URL(next);
  u.searchParams.delete("access_token");
  checkUrl(spec, u);
  return u.toString();
}

async function all<T>(path: string, query: Record<string, string | number | undefined>, token: "META_ADS_TOKEN" | "META_PAGE_TOKEN", maxPages = 100): Promise<T[]> {
  const managed = composioEnabled("meta-ads");
  if (managed && token === "META_PAGE_TOKEN" && !composioEnabled("meta-page")) throw new Error("meta-ads: configure the separate meta-page managed connection for page leads");
  const targetSpec = managed && token === "META_PAGE_TOKEN" ? { ...spec, app: "meta-page" } : spec;
  const h = bearer(token);
  const first = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) first.searchParams.set(k, String(v));
  return collect<T, string>(first.toString(), async (url) => {
    const r = await call<any>(targetSpec, { url, headers: h });
    return { items: r.data?.data ?? [], next: cleanNext(r.data?.paging?.next) };
  }, { maxPages });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function timeParams(since?: string, until?: string, today = new Date().toISOString().slice(0, 10)): Record<string, string> {
  if (!since && !until) return { date_preset: "maximum" };
  if (!since) throw new Error("until needs since");
  const end = until ?? today;
  if (!DATE.test(since) || !DATE.test(end)) throw new Error("dates must be YYYY-MM-DD");
  if (end < since) throw new Error("until is before since");
  return { time_range: JSON.stringify({ since, until: end }), time_increment: "1" };
}

/**
 * Spend and results for an ad account (act_123), campaign or ad set, at account, campaign, adset or ad
 * level. Daily rows for a bounded window, the same shape the CRM reconciles against Ads Manager.
 */
export async function insights(node: string, o: { nodeType?: "account" | "campaign" | "adset"; level?: "account" | "campaign" | "adset" | "ad"; since?: string; until?: string } = {}): Promise<any[]> {
  // The CRM's default: an ad set is read at ad level, a campaign at campaign level, an account at account level.
  const kind = o.nodeType ?? (node.startsWith("act_") ? "account" : undefined);
  if (!o.level && !kind) throw new Error("insights: say whether the node is an account, campaign or adset, or pass a level");
  const level = o.level ?? (kind === "adset" ? "ad" : kind === "campaign" ? "campaign" : "account");
  return all(`${encodeURIComponent(node)}/insights`, {
    fields: "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,ctr,cpc,cpm,reach,actions,cost_per_action_type",
    level, limit: 200, ...timeParams(o.since, o.until),
  }, "META_ADS_TOKEN");
}

/**
 * Meta reports one lead under several action types on the same row. They are the same lead and must
 * never be summed: "lead" wins when present, otherwise the largest of the others.
 */
export const LEAD_ACTION_TYPES = ["lead", "offsite_conversion.fb_pixel_lead", "onsite_web_lead", "onsite_conversion.lead_grouped"];
export function leadCount(row: { actions?: { action_type: string; value: string }[] }): number {
  const a = row.actions ?? [];
  const lead = a.find((x) => x.action_type === "lead");
  if (lead) return Number(lead.value) || 0;
  return a.filter((x) => LEAD_ACTION_TYPES.includes(x.action_type)).reduce((m, x) => Math.max(m, Number(x.value) || 0), 0);
}

/**
 * Daily rows added up per ad (or ad set, campaign, account): spend, impressions, clicks, leads, then
 * click-through rate and cost per lead. Ported from scripts/lib-meta-insights.ts aggregateRows.
 */
export function totals(rows: any[]): any[] {
  const byKey = new Map<string, any>();
  for (const r of rows) {
    const key = r.ad_id ?? r.adset_id ?? r.campaign_id ?? r.ad_name ?? r.adset_name ?? r.campaign_name ?? "(account)";
    const cur = byKey.get(key) ?? { ...r, spend: 0, impressions: 0, clicks: 0, leads: 0 };
    cur.spend += Number(r.spend) || 0;
    cur.impressions += Number(r.impressions) || 0;
    cur.clicks += Number(r.clicks) || 0;
    cur.leads += leadCount(r);
    byKey.set(key, cur);
  }
  return Array.from(byKey.values()).map((x) => ({ ...x, ctr: x.impressions ? (x.clicks / x.impressions) * 100 : 0, cpl: x.leads ? x.spend / x.leads : null }));
}

export function listLeadForms(pageId: string): Promise<{ id: string; name: string; status: string }[]> {
  return all(`${encodeURIComponent(pageId)}/leadgen_forms`, { fields: "id,name,status", limit: 100 }, "META_PAGE_TOKEN");
}

export interface MetaLead { id: string; created_time: string; ad_id?: string; ad_name?: string; campaign_id?: string; form_id?: string; is_organic?: boolean; field_data: { name: string; values: string[] }[] }

/** Leads on one form since a unix time. Run often with a day of overlap and dedupe on the lead id. */
export function listLeads(formId: string, sinceUnix: number): Promise<MetaLead[]> {
  return all(`${encodeURIComponent(formId)}/leads`, {
    fields: "id,created_time,ad_id,ad_name,campaign_id,form_id,is_organic,field_data",
    filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: sinceUnix }]), limit: 100,
  }, "META_PAGE_TOKEN");
}

/** A lead's answers as a plain object: { email, phone_number, full_name, ... }. */
export const leadFields = (l: MetaLead): Record<string, string> => Object.fromEntries(l.field_data.map((f) => [f.name, f.values?.[0] ?? ""]));

const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const norm = (v?: string | null) => (v ?? "").trim().toLowerCase();

/** Hashed customer details, as Meta's Conversions API wants them. */
export function userData(p: { id: string; email?: string | null; phone?: string | null; name?: string | null; state?: string | null; country?: string }) {
  const u: Record<string, string[]> = { country: [sha(norm(p.country ?? "au"))], external_id: [sha(p.id)] };
  if (norm(p.email)) u.em = [sha(norm(p.email))];
  const ph = (p.phone ?? "").replace(/\D/g, ""); if (ph) u.ph = [sha(ph)];
  const parts = norm(p.name).split(/\s+/).filter(Boolean);
  if (parts[0]) u.fn = [sha(parts[0])];
  if (parts.length > 1) u.ln = [sha(parts[parts.length - 1])];
  if (norm(p.state)) u.st = [sha(norm(p.state))];
  return u;
}

/**
 * Sends conversion events (a booked call, a sale) to the pixel. Needs KIT_ALLOW_WRITES=1.
 * With a test code, Meta does not reject a stale code: it counts the event as real and only says so
 * in a message. So a test send that gets that message stops at once.
 */
export async function sendConversions(events: { event_name: string; event_time: number; event_id: string; user_data: Record<string, string[]>; custom_data?: Record<string, unknown> }[], testCode?: string): Promise<{ received: number; messages: string[]; fbtraceId: string | null }> {
  const r = await call<any>(spec, {
    method: "POST", url: `${API}/${encodeURIComponent(secret("META_PIXEL_ID"))}/events`, headers: bearer("META_ADS_TOKEN"),
    json: { data: events.map((e) => ({ action_source: "system_generated", ...e })), ...(testCode ? { test_event_code: testCode } : {}) },
  });
  if (r.data?.error) throw new Error(`meta: conversions refused (${String(r.data.error.message ?? "no reason given").slice(0, 120)})`);
  const messages: string[] = r.data?.messages ?? [];
  if (testCode && /does not match an active Test Events session/i.test(messages.join(" "))) {
    throw new Error("Meta counted this test as a LIVE event: the test code is not active. Stopping.");
  }
  // fbtrace_id is Meta's reference for this send; the CRM stores it on each row so a problem can be traced.
  return { received: r.data?.events_received ?? 0, messages, fbtraceId: r.data?.fbtrace_id ?? null };
}
