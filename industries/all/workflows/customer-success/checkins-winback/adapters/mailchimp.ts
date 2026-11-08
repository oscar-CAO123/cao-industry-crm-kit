// Mailchimp for the check-in workflow. Field names come from Mailchimp's official OpenAPI reference:
// members (members[].id, email_address, tags[].name, last_changed, total_items), conversations (conversations[].id,
// campaign_id, from_email, message_count), campaigns (id; recipients.list_id, recipients.segment_opts.saved_segment_id;
// settings.subject_line, title, from_name, reply_to), campaign content (html) and member notes (note).
// Reads and drafts only here. The send is built by sendAct() and only ever reaches the approval queue.
import crypto from "node:crypto";
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Group, type Settings, ID_TOKEN, SUBSCRIBER_HASH, EMAIL, day } from "../types.ts";

const P = "mailchimp";
const PAGE = 500;

function listOf(s: Settings): string {
  const v = String(s.mailchimp?.list_id ?? "");
  if (!ID_TOKEN.test(v)) throw new Error("mailchimp: bad list id");
  return v;
}
function idOf(v: unknown): string {
  const s = String(v ?? "");
  if (!ID_TOKEN.test(s)) throw new Error("mailchimp: bad id");
  return s;
}
/** Mailchimp identifies a member by the MD5 of the lower-cased address. */
export function subscriberHash(email: string): string {
  if (!EMAIL.test(email)) throw new Error("mailchimp: bad address");
  return crypto.createHash("md5").update(email.toLowerCase()).digest("hex");
}

/** The send, as an approval act. It only runs when a person approves it in the CRM shell. */
export const sendAct = (campaignId: string, summary: string, key: string): Act => ({
  platform: P, op: "core.campaigns_create-action-send", key, summary,
  input: { params: { campaign_id: idOf(campaignId) } },
});

export const mailchimp: Adapter = {
  id: P,
  async members(ctx) {
    const cap = ctx.settings.max_members_per_run ?? 5000;
    const out: { id: string; tags: string[]; last_changed: string }[] = [];
    let offset = 0, total = Infinity;
    while (offset < total && out.length < cap) {
      const r = await ctx.draft<any>({ platform: P, op: "core.lists_list-members", summary: `read subscribed members from ${offset}`,
        input: { params: { list_id: listOf(ctx.settings), status: "subscribed", count: PAGE, offset } } });
      const d = r.data ?? {};
      total = Number(d.total_items ?? 0);
      const rows: any[] = Array.isArray(d.members) ? d.members : [];
      if (!rows.length) break;
      for (const m of rows) {
        if (out.length >= cap) break;
        const id = String(m?.id ?? "");
        if (!SUBSCRIBER_HASH.test(id)) continue;
        out.push({ id, tags: Array.isArray(m.tags) ? m.tags.map((t: any) => String(t?.name ?? "")).filter(Boolean) : [], last_changed: String(m.last_changed ?? "") });
      }
      offset += rows.length;
    }
    if (out.length >= cap) ctx.log(`mailchimp: member read stopped at ${cap}`);
    return out;
  },
  async unreadReplies(ctx) {
    const r = await ctx.draft<any>({ platform: P, op: "core.conversations_list", summary: "read conversations with unread replies",
      input: { params: { list_id: listOf(ctx.settings), has_unread_messages: "true", count: 50 } } });
    const rows: any[] = Array.isArray(r.data?.conversations) ? r.data.conversations : [];
    return rows
      .filter((c) => ID_TOKEN.test(String(c?.id ?? "")) && ID_TOKEN.test(String(c?.campaign_id ?? "")))
      .map((c) => ({ id: String(c.id), campaign_id: String(c.campaign_id), message_count: Number(c.message_count ?? 0),
                     from_email: typeof c.from_email === "string" && EMAIL.test(c.from_email) ? c.from_email : undefined }));
  },
  async createDraft(ctx, g: Group) {
    const s = ctx.settings;
    const r = await ctx.draft<any>({ platform: P, op: "core.campaigns_create", summary: `draft campaign for ${g.name}`,
      input: { body: {
        type: "regular",
        recipients: { list_id: listOf(s), segment_opts: { saved_segment_id: g.segment_id } },
        settings: { subject_line: g.subject, title: `${g.name} ${day(ctx.now)}`.slice(0, 100), from_name: s.from_name, reply_to: s.reply_to },
      } } });
    const id = String(r.data?.id ?? "");
    if (!ID_TOKEN.test(id)) throw new Error("mailchimp: campaign create returned no id");
    return id;
  },
  async setContent(ctx, campaignId, html) {
    await ctx.draft({ platform: P, op: "core.campaigns_upsert-content", summary: "owner-approved body on the draft campaign",
      input: { params: { campaign_id: idOf(campaignId) }, body: { html } } });
  },
  async note(ctx, hash, text) {
    if (!SUBSCRIBER_HASH.test(hash)) throw new Error("mailchimp: bad subscriber hash");
    await ctx.draft({ platform: P, op: "core.lists_create-member-note", summary: "internal note on a member",
      input: { params: { list_id: listOf(ctx.settings), subscriber_hash: hash }, body: { note: text.slice(0, 1000) } } });
  },
};
