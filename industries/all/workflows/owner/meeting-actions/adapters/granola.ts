// Granola: notes its app recorded, with its AI summary and transcript. Read only. The kit maps no Granola operation that
// sends or shares a note, so a Granola meeting never gets a recap share from this workflow.
// Field names: the OpenAPI spec in endpoint-map/raw/granola (ListNotesOutput, Note, GetTranscriptOutput, Transcript).
import { createHash } from "node:crypto";
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Meeting, type Notetaker, type Settings, GRANOLA_ID, clamp, cut, keyOf } from "../types.ts";

const P = "granola";
const MAX_LIST_PAGES = 3;
const MAX_TRANSCRIPT_CHARS = 30000;

export const granola: Notetaker = {
  id: P,
  async meetings(ctx: Ctx<Settings>) {
    const since = new Date(ctx.now.getTime() - (ctx.settings.lookback_days ?? 14) * 864e5).toISOString();
    const size = clamp(ctx.settings.granola?.page_size ?? 30, 1, 100);
    const out: Omit<Meeting, "status">[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const r = await ctx.draft<any>({ platform: P, op: "get /v1/notes", summary: "list recent notes",
        input: { params: { updated_after: since, page_size: size, ...(cursor ? { cursor } : {}) } } });
      const notes: any[] = Array.isArray(r.data?.notes) ? r.data.notes : [];
      for (const n of notes) {
        if (!GRANOLA_ID.test(String(n?.id ?? ""))) continue;
        out.push(await detail(ctx, n));
      }
      cursor = r.data?.hasMore && typeof r.data?.cursor === "string" ? r.data.cursor : undefined;
      if (!cursor) break;
    }
    return out;
  },
};

async function detail(ctx: Ctx<Settings>, n: any): Promise<Omit<Meeting, "status">> {
  const id = String(n.id);
  const d: any = (await ctx.draft<any>({ platform: P, op: "get /v1/notes/{note_id}", summary: "read a note",
    input: { params: { note_id: id } } })).data ?? {};
  const transcript = await transcriptText(ctx, id);
  const summary = cut(d.summary_markdown || d.summary_text || "", 8000);
  const title = cut(d.title || n.title || "Meeting", 200);
  const when = cut(d.created_at || n.created_at || ctx.now.toISOString(), 40);
  return {
    key: keyOf(P, id), platform: P, id, title, when, summary, transcript,
    attendees: (Array.isArray(d.attendees) ? d.attendees : []).map((a: any) => cut(a?.name, 120)).filter(Boolean).slice(0, 30),
    fingerprint: createHash("sha256").update(JSON.stringify([n.updated_at ?? d.updated_at, title, summary, transcript.length])).digest("hex").slice(0, 16),
  };
}

/** The transcript as "source: text" lines, read page by page up to the settings limit and capped in length. */
async function transcriptText(ctx: Ctx<Settings>, id: string): Promise<string> {
  const max = clamp(ctx.settings.granola?.max_transcript_pages ?? 5, 1, 10);
  const lines: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < max; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "get /v1/notes/{note_id}/transcript", summary: "read a transcript",
      input: { params: { note_id: id, page_size: 100, ...(cursor ? { cursor } : {}) } } });
    for (const t of Array.isArray(r.data?.transcript) ? r.data.transcript : []) {
      lines.push(`${cut(t?.speaker?.source ?? "speaker", 20)}: ${cut(t?.text, 1000)}`);
    }
    cursor = r.data?.hasMore && typeof r.data?.cursor === "string" ? r.data.cursor : undefined;
    if (!cursor) break;
  }
  return cut(lines.join("\n"), MAX_TRANSCRIPT_CHARS);
}
