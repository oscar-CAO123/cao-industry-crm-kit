// GoHighLevel: open opportunities in the watched stages are the leads and quotes. A touch is drafted as a contact task and a
// note holding the message, then the message is queued for approval as a send to the contact. A move to lost is queued too.
// Field names: v3 opportunities search (locationId, pipelineId, pipelineStageId, status, limit; reply opportunities[] with
// id, name, pipelineStageId, status, contactId), v3 POST /contacts/{contactId}/tasks (title, body, dueDate, completed),
// v3 POST /contacts/{contactId}/notes (body), conversations POST /conversations/messages (type, subType, contactId, status,
// message, subject, html), v3 PUT /opportunities/{id}/status (status, lostReasonId). From GoHighLevel's official OpenAPI files.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Found, type Lead, type Settings, type Watch, ID, esc, clip } from "../types.ts";

const P = "gohighlevel" as const;
const PAGE = 100;

export const gohighlevel: Adapter = {
  id: P,

  async watched(ctx: Ctx<Settings>, w: Watch) {
    const s = ctx.settings;
    if (!ID.test(s.location_id ?? "") || !ID.test(s.pipeline_id) || !ID.test(w.stage_id)) throw new Error("lead-followup: location, pipeline and stage ids must be plain ids");
    const r = await ctx.draft<any>({ platform: P, op: "v3__opportunities-v3.search-opportunity", summary: `read open opportunities in stage ${w.stage_id}`,
      input: { params: { locationId: s.location_id, pipelineId: s.pipeline_id, pipelineStageId: w.stage_id, status: "open", limit: PAGE } } });
    const list: any[] = Array.isArray(r.data?.opportunities) ? r.data.opportunities : [];
    const items: Found[] = list
      .filter((o) => ID.test(String(o?.id ?? "")))
      .map((o) => ({
        id: String(o.id), title: clip(o.name, 120), stage_id: String(o.pipelineStageId ?? w.stage_id), status: String(o.status ?? "open"),
        contact_id: ID.test(String(o.contactId ?? "")) ? String(o.contactId) : undefined,
      }));
    return { items, truncated: list.length >= PAGE };
  },

  async draftTouch(ctx: Ctx<Settings>, lead: Lead, text: string, n: number) {
    if (!lead.contact_id) throw new Error(`lead-followup: ${lead.key} has no contact to write on`);
    await ctx.draft({ platform: P, op: "contacts.create-task", summary: `task for touch ${n + 1} on ${lead.key}`,
      input: { params: { contactId: lead.contact_id }, body: { title: clip(`Follow up: ${lead.title}`, 200), body: text, dueDate: ctx.now.toISOString(), completed: false } } });
    await ctx.draft({ platform: P, op: "contacts.create-note", summary: `note with the drafted message for ${lead.key} (touch ${n + 1})`,
      input: { params: { contactId: lead.contact_id }, body: { body: `Drafted touch ${n + 1}:\n${text}` } } });
  },

  async queueSend(ctx: Ctx<Settings>, lead: Lead, text: string, key: string) {
    const channel = ctx.settings.channel ?? "sms";
    const body = channel === "email"
      ? { type: "Email", subType: "email", contactId: lead.contact_id, status: "pending",
          subject: clip(ctx.settings.email_subject ?? `Following up: ${lead.title}`, 200), message: text, html: `<p>${esc(text)}</p>` }
      : { type: "SMS", subType: "sms", contactId: lead.contact_id, status: "pending", message: text };
    return ctx.queue({ platform: P, op: "conversations.send-a-new-message", key, input: { body } },
      `Send ${channel} to ${clip(lead.title, 80)}: ${clip(text, 300)}`);
  },

  async queueLost(ctx: Ctx<Settings>, lead: Lead, key: string) {
    const reason = ctx.settings.lost_reason_id;
    return ctx.queue({ platform: P, op: "opportunities.update-opportunity-status", key,
      input: { params: { id: lead.id }, body: { status: "lost", ...(ID.test(reason ?? "") ? { lostReasonId: reason } : {}) } } },
      `Mark "${clip(lead.title, 80)}" lost after no reply`);
  },
};
