// Aircall: the call log (read) and a caller's contact record (a draft inside the business's own system).
// Texts through Aircall are not wired here: its send operation maps the number id as both a query and a path part (see gaps).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type CallRecord, type Settings, toE164 } from "../types.ts";

const P = "aircall";

export const aircall: Adapter = {
  id: P,
  async calls(ctx: Ctx<Settings>, since) {
    const r = await ctx.draft<any>({ platform: P, op: "list-all-calls", summary: "list calls since the window",
      input: { params: { from: String(Math.floor(since.getTime() / 1000)), order: "asc" } } });
    const out: Omit<CallRecord, "status" | "urgent">[] = [];
    for (const c of Array.isArray(r.data?.calls) ? r.data.calls : []) {
      if (!c || (typeof c.id !== "number" && typeof c.id !== "string")) continue;
      if (c.direction === "outbound") continue;                       // our own calls out are not enquiries
      const started = Number(c.started_at);
      if (!Number.isFinite(started)) continue;
      out.push({ id: safeKey(`${P}:${c.id}`), platform: P, call_id: String(c.id), caller: toE164(c.raw_digits),
                 received: new Date(started * 1000).toISOString(), notes: "" });
    }
    return out;
  },
  async createContact(ctx: Ctx<Settings>, c: CallRecord) {
    if (!c.caller) return undefined;
    // The information field carries the call's own key, so a person can trace the contact back to the call.
    const r = await ctx.draft<any>({ platform: P, op: "create-a-contact", summary: `caller record for after-hours call ${c.call_id}`,
      input: { body: { information: `external_custom_id:${c.id}`, phone_numbers: [{ label: "Work", value: c.caller }] } } });
    const id = r.data?.contact?.id;
    return id === undefined ? undefined : String(id);
  },
};
