// Shared shapes for the check-in, renewal and win-back workflow. The adapter speaks these; the crons only use these.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";

export type Platform = "mailchimp";

/** One customer group the owner defines: a Mailchimp tag, a saved segment, and the owner-approved message. */
export interface Group {
  name: string;          // a short key, e.g. lapsed-90-days
  tag: string;           // the Mailchimp tag a person puts on members in this group
  segment_id: number;    // the saved segment (Mailchimp's id) the campaign sends to
  after_days: number;    // a member is due once their record has not changed for this many days
  subject: string;       // subject line of the campaign
  html: string;          // owner-approved HTML body; no customer text is ever placed in it
}

export interface Settings {
  business_name?: string;
  from_name: string;
  reply_to: string;
  mailchimp: { list_id: string };
  groups: Group[];
  max_members_per_run?: number;
}

/** What the due-list cron keeps per group: subscriber hashes only, never names or addresses. */
export interface DueRecord { group: string; hashes: string[]; seen: string }
/** One campaign draft per group per day, written as soon as Mailchimp returns its id. */
export interface CampaignRecord { key: string; group: string; day: string; campaign_id: string; due: number; created: string }
/** One note per conversation and message count, so a re-run never notes the same reply twice. */
export interface ReplyRecord { key: string; hash: string; noted: string }

export const DAY = 864e5;
export const SAFE_GROUP = /^[a-z0-9][a-z0-9-]{0,60}$/;
/** Mailchimp list, campaign and conversation ids: short alphanumeric tokens. */
export const ID_TOKEN = /^[a-z0-9]{6,40}$/i;
export const SUBSCRIBER_HASH = /^[a-f0-9]{32}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

export const keyOf = (s: string) => safeKey(s, 90);
/** The day a campaign belongs to, in UTC. */
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** Throws on any setting that would reach a path, a filter or an email unchecked. Run before the first network call. */
export function checkSettings(s: Settings): void {
  if (!ID_TOKEN.test(String(s.mailchimp?.list_id ?? ""))) throw new Error("checkins-winback: mailchimp.list_id is not a Mailchimp list id");
  if (!EMAIL.test(String(s.reply_to ?? ""))) throw new Error("checkins-winback: reply_to is not an email address");
  if (!s.from_name || s.from_name.length > 100) throw new Error("checkins-winback: from_name is missing or too long");
  if (!Array.isArray(s.groups) || !s.groups.length) throw new Error("checkins-winback: no groups");
  for (const g of s.groups) {
    if (!SAFE_GROUP.test(g.name)) throw new Error(`checkins-winback: bad group name ${g.name}`);
    if (!g.tag || g.tag.length > 80) throw new Error(`checkins-winback: bad tag on ${g.name}`);
    if (!Number.isInteger(g.segment_id) || g.segment_id <= 0) throw new Error(`checkins-winback: bad segment_id on ${g.name}`);
    if (!(g.after_days >= 1 && g.after_days <= 3650)) throw new Error(`checkins-winback: bad after_days on ${g.name}`);
    if (!g.subject || g.subject.length > 150) throw new Error(`checkins-winback: bad subject on ${g.name}`);
  }
}

export interface Adapter {
  id: Platform;
  /** Subscribed members of the list, read with paging and capped by the run limit. */
  members(ctx: Ctx<Settings>): Promise<{ id: string; tags: string[]; last_changed: string }[]>;
  /** Conversations with unread replies that belong to a campaign, with the sender's address (used only to find the member). */
  unreadReplies(ctx: Ctx<Settings>): Promise<{ id: string; campaign_id: string; message_count: number; from_email?: string }[]>;
  /** A regular campaign draft to one saved segment of the list. Returns the campaign id. */
  createDraft(ctx: Ctx<Settings>, g: Group): Promise<string>;
  /** The owner-approved HTML body on a draft campaign. */
  setContent(ctx: Ctx<Settings>, campaignId: string, html: string): Promise<void>;
  /** An internal note on a member, so a person sees what the workflow did. */
  note(ctx: Ctx<Settings>, hash: string, text: string): Promise<void>;
}
