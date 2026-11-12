// HubSpot: the partner client record (read, as draft operations) and the calendar meeting that invites the client
// (a live operation: the invite reaches the client, so this file only makes a queue entry for approval).
// Field names come from the vendor spec.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings, Slot } from "../types.ts";

const P = "hubspot";
export const OP_LIST = "crm-partner-clients-3.get-/crm/v3/objects/partner_clients";
export const OP_ONE = "crm-partner-clients-3.get-/crm/v3/objects/partner_clients/{partnerClientId}";
export const OP_INVITE = "scheduler-meetings-3.post-/scheduler/v3/meetings/calendar";

const NUM = /^\d{1,20}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,100}$/;
export const hsId = (v: unknown) => { const s = String(v ?? ""); if (!NUM.test(s)) throw new Error("hubspot: bad id"); return s; };
const iso = (v: unknown) => { const s = String(v ?? ""); const t = Date.parse(s); if (s.length > 40 || !Number.isFinite(t)) throw new Error("hubspot: bad time"); return new Date(t).toISOString(); };

export interface PartnerClient { id: string; properties: Record<string, string> }

/** Every partner client, with the name, review-date and pack properties. Rows with a non-numeric id are skipped. */
export async function clients(ctx: Ctx<Settings>): Promise<PartnerClient[]> {
  const hs = ctx.settings.hubspot;
  const properties = [...new Set([hs.name_property, hs.due_property, ...hs.pack_properties])];
  const out: PartnerClient[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await ctx.draft<any>({ platform: P, op: OP_LIST, summary: "list partner clients",
      input: { params: { limit: 100, properties, ...(after ? { after } : {}) } } });
    for (const row of r.data?.results ?? []) {
      const id = String(row?.id ?? "");
      if (!NUM.test(id)) { ctx.log("hubspot: skipped a partner client with a non-numeric id"); continue; }
      out.push({ id, properties: row.properties ?? {} });
    }
    const next = r.data?.paging?.next?.after;
    after = typeof next === "string" && CURSOR.test(next) ? next : undefined;
    if (!after) return out;
  }
  ctx.log("hubspot: stopped after 20 pages of partner clients");
  return out;
}

/** One partner client, read for its review pack. */
export async function client(ctx: Ctx<Settings>, id: string): Promise<PartnerClient> {
  const r = await ctx.draft<any>({ platform: P, op: OP_ONE, summary: `read partner client ${hsId(id)}`,
    input: { params: { partnerClientId: hsId(id), properties: ctx.settings.hubspot.pack_properties } } });
  return { id: hsId(r.data?.id), properties: r.data?.properties ?? {} };
}

/** Queue the calendar invite for one client and one agreed slot. Nothing is sent until an adviser approves it. */
export function queueInvite(ctx: Ctx<Settings>, c: { id: string; name: string }, slot: Slot, round = 0): Promise<string> {
  const start = iso(slot.start), end = iso(slot.end);
  if (Date.parse(end) <= Date.parse(start)) throw new Error("hubspot: the review must end after it starts");
  const hs = ctx.settings.hubspot;
  const summary = `invite ${c.name} to a portfolio review at ${start}`;
  // A rejected invite is queued again under a new key (round + 1), so the old rejected approval does not block it.
  const key = `review:${hsId(c.id)}:${start}${round ? `:r${round}` : ""}`;
  return ctx.queue({ platform: P, op: OP_INVITE, key, summary,
    input: { params: { organizerUserId: hsId(hs.organizer_user_id) }, body: {
      timezone: ctx.settings.timezone,
      associations: [],
      properties: {
        hs_meeting_title: `Portfolio review: ${c.name}`.slice(0, 200),
        hs_meeting_start_time: start,
        hs_meeting_end_time: end,
        hs_meeting_outcome: "SCHEDULED",
        hs_timestamp: start,
        hubspot_owner_id: hsId(hs.owner_id),
      } } } }, summary);
}
