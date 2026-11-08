// JustCall: the missed-call log (read) and texts (live: a text reaches a caller, so it is only ever queued).
// Field names come from the vendor's official spec (endpoint-map/raw/justcall): call_type INCOMING_MISSED, justcall_number,
// call_date, call_time (UTC), contact_number; texts/new takes justcall_number, contact_number, body, restrict_once.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type MissedCall, type Settings, toE164 } from "../types.ts";

const P = "justcall";
const ID = /^\d{1,12}$/;

/** Missed incoming calls on the business number, read from the call log. Read only. */
export async function missedCalls(ctx: Ctx<Settings>, since: Date): Promise<MissedCall[]> {
  const r = await ctx.draft<any>({ platform: P, op: "docs.get_v2_1_calls", summary: "missed calls on the business number",
    input: { params: { call_type: "INCOMING_MISSED", call_direction: "Incoming", justcall_number: ctx.settings.justcall.number, per_page: 100, page: 1 } } });
  // The docs confirm the per-call fields; the list wrapper is read as an array or as its data array (see gaps).
  const rows: any[] = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.data) ? r.data.data : [];
  const out: MissedCall[] = [];
  for (const c of rows) {
    const raw = String(c?.id ?? "");
    if (!ID.test(raw)) continue;                                              // a call id we cannot key is skipped
    if (c.call_info?.direction && c.call_info.direction !== "Incoming") continue;
    const received = Date.parse(`${c.call_date}T${c.call_time ?? "00:00:00"}Z`);
    if (!Number.isFinite(received) || received < since.getTime()) continue;
    out.push({ key: safeKey(`${P}:${raw}`), call_id: raw, received: new Date(received).toISOString(), caller: toE164(c.contact_number) });
  }
  return out;
}

/** A text from the business's JustCall number. Queued only: a person approves it. restrict_once stops a repeat within 24 hours. */
export function textAct(s: Settings, to: string, body: string, key: string): Act {
  return { platform: P, op: "docs.post_v2_1_texts_new", key, summary: `text ${to}`,
    input: { body: { justcall_number: s.justcall.number, contact_number: to, body: body.slice(0, 300), restrict_once: "Yes" } } };
}
