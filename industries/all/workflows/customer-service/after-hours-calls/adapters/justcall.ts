// JustCall: the call log (read) and texts (live: a text reaches a caller or the on-call person, so it is only ever queued).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type CallRecord, type Settings, toE164 } from "../types.ts";

const P = "justcall";
const PAGE = 100;
const MAX_PAGES = 10;

export const justcall: Adapter = {
  id: P,
  async calls(ctx: Ctx<Settings>, since) {
    // Pages until a short page. The window is cut after the read, because the from_datetime format and the sort order are not
    // confirmed in the docs. The cap bounds one run; a run that hits it logs that older calls may be unread.
    const rows: any[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await ctx.draft<any>({ platform: P, op: "docs.get_v2_1_calls", summary: `list the calls, page ${page}`,
        input: { params: { per_page: PAGE, page } } });
      // The docs confirm the per-call fields; the list wrapper is read as an array or as its data array (see gaps).
      const batch: any[] = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.data) ? r.data.data : [];
      rows.push(...batch);
      if (batch.length < PAGE) break;
      if (page === MAX_PAGES) ctx.log(`justcall: stopped at ${MAX_PAGES} pages of ${PAGE}; older calls may be unread this run`);
    }
    const out: Omit<CallRecord, "status" | "urgent">[] = [];
    for (const c of rows) {
      if (!c || (typeof c.id !== "number" && typeof c.id !== "string")) continue;
      const info = c.call_info ?? {};
      if (info.direction !== "Incoming") continue;                    // our own calls out are not enquiries
      const received = Date.parse(`${c.call_date}T${c.call_time ?? "00:00:00"}Z`);
      if (!Number.isFinite(received) || received < since.getTime()) continue;
      const notes = [info.notes, info.voicemail_transcription].filter((x) => typeof x === "string").join(" ").slice(0, 2000);
      out.push({ id: safeKey(`${P}:${c.id}`), platform: P, call_id: String(c.id), caller: toE164(c.contact_number),
                 received: new Date(received).toISOString(), notes });
    }
    return out;
  },
};

/** A text from the business's JustCall number. Queued only: a person approves it. restrict_once stops a repeat within 24 hours. */
export function textAct(s: Settings, to: string, body: string, key: string): Act {
  return { platform: P, op: "docs.post_v2_1_texts_new", key, summary: `text ${to}`,
    input: { body: { justcall_number: s.justcall!.number, contact_number: to, body: body.slice(0, 300), restrict_once: "Yes" } } };
}
