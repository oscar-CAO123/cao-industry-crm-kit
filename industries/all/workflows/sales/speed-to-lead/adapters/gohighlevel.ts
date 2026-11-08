// GoHighLevel: where the new lead, the conversation and the owner's task live. Field names come from the vendor's
// official spec (endpoint-map/raw/gohighlevel/spec). Reads and internal tasks are draft operations; a text to the lead is
// live and only ever queued by index.ts.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, clean, id, phoneOf, ID } from "../types.ts";

const P = "gohighlevel";

export interface Fresh { opp: string; contact: string; name: string; phone?: string; created: string }

export const gohighlevel = {
  /** Open opportunities still in the new-lead stage of the configured pipeline. */
  async newOpenLeads(ctx: Ctx<Settings>): Promise<Fresh[]> {
    const s = ctx.settings;
    const r = await ctx.draft<any>({ platform: P, op: "opportunities.search-opportunity", summary: "open leads in the new-lead stage",
      input: { params: { location_id: s.location_id, pipeline_id: s.pipeline_id, pipeline_stage_id: s.new_lead_stage_id, status: "open", limit: 50 } } });
    const out: Fresh[] = [];
    for (const o of r.data?.opportunities ?? []) {
      try {
        const created = String(o.createdAt ?? "");
        if (!Number.isFinite(Date.parse(created))) throw new Error("no createdAt");
        out.push({ opp: id(o.id, "opportunity id"), contact: id(o.contactId, "contact id"),
          name: clean(o.contact?.name || o.name, 80) || "New lead", phone: phoneOf(o.contact?.phone), created });
      } catch {
        ctx.log("skipped a lead row with a bad id or date");
      }
    }
    return out;
  },

  /** The opportunity's status and stage now. A person who moved it out of the new-lead stage has already handled it. */
  async opportunity(ctx: Ctx<Settings>, opp: string): Promise<{ status: string; pipelineStageId: string }> {
    const r = await ctx.draft<any>({ platform: P, op: "opportunities.get-opportunity", summary: "current stage of a lead",
      input: { params: { id: id(opp, "opportunity id") } } });
    const o = r.data?.opportunity ?? {};
    return { status: String(o.status ?? ""), pipelineStageId: String(o.pipelineStageId ?? "") };
  },

  /** True when any outbound message has already gone to this contact (a person, or an automation the business set up). */
  async hasOutbound(ctx: Ctx<Settings>, contact: string): Promise<boolean> {
    const c = await ctx.draft<any>({ platform: P, op: "conversations.search-conversation", summary: "conversations for a lead",
      input: { params: { locationId: ctx.settings.location_id, contactId: id(contact, "contact id") } } });
    for (const conv of (c.data?.conversations ?? []).filter((x: any) => ID.test(String(x?.id ?? "")))) {
      const m = await ctx.draft<any>({ platform: P, op: "conversations.get-messages", summary: "messages in a conversation",
        input: { params: { conversationId: conv.id } } });
      if ((m.data?.messages ?? []).some((x: any) => x?.direction === "outbound")) return true;
    }
    return false;
  },

  /** An internal task for one staff member about one lead. It reaches nobody outside the business. */
  async task(ctx: Ctx<Settings>, contact: string, assignee: string, title: string, note: string): Promise<void> {
    await ctx.draft({ platform: P, op: "contacts.create-task", summary: title,
      input: { params: { contactId: id(contact, "contact id") },
        body: { title: clean(title, 120), body: clean(note, 500), dueDate: ctx.now.toISOString(), completed: false, assignedTo: id(assignee, "user id") } } });
  },
};
