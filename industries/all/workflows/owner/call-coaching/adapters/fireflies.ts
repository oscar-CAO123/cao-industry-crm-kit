// Fireflies: the notetaker's transcripts. Every call here is a GraphQL query, so it is a read.
// Field names from Fireflies' own GraphQL docs (transcript query: id, title, date, organizer_email, duration,
// summary { overview, short_summary, action_items }, sentences { speaker_name, text }).
// Replies are the GraphQL envelope { data: {...} }, so the field is read out of data.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type CallRecord, type Settings, TRANSCRIPT_CAP, clip, keyOf } from "../types.ts";

const P = "fireflies" as const;
const TID = /^[A-Za-z0-9_-]{4,80}$/;

/** A field of the GraphQL envelope. The error text is never copied out: it can hold client data. */
function field<T>(body: any, name: string): T | undefined {
  if (body?.errors?.length) throw new Error(`fireflies: ${name} query failed`);
  return body?.data?.[name] as T | undefined;
}

/** Fireflies gives action items as lines of text: keep up to ten short ones. */
const actionItems = (s: unknown) =>
  String(s ?? "").split("\n").map((x) => x.replace(/^[\s*\-\d.)]+/, "").trim()).filter(Boolean).slice(0, 10).map((x) => clip(x, 300));

/** Calls recorded since the watermark that are not stored yet. */
export async function recent(ctx: Ctx<Settings>, since: string | undefined, max: number): Promise<CallRecord[]> {
  const listed = await ctx.draft<any>({ platform: P, op: "query.transcripts", summary: "list recent transcripts",
    input: { params: { limit: max, ...(since ? { fromDate: since } : {}) } } });
  const list = field<any[]>(listed.data, "transcripts") ?? [];
  const out: CallRecord[] = [];
  for (const t of list.slice(0, max)) {
    const id = String(t?.id ?? "");
    if (!TID.test(id)) continue;
    const key = keyOf(`${P}:${id}`);
    if (await ctx.store.get("calls", key)) continue;
    const one = await ctx.draft<any>({ platform: P, op: "query.transcript", summary: "read one transcript", input: { params: { id } } });
    const tr = field<any>(one.data, "transcript");
    if (!tr) continue;
    const text = (tr.sentences ?? []).map((s: any) => `${clip(s?.speaker_name, 80)}: ${clip(s?.text, 2000)}`).join("\n");
    out.push({
      key, platform: P, ref: id, title: clip(tr.title ?? "Call", 200),
      happened: typeof tr.date === "number" ? new Date(tr.date).toISOString() : clip(tr.date ?? ctx.now.toISOString(), 40),
      rep: typeof tr.organizer_email === "string" ? clip(tr.organizer_email.toLowerCase(), 200) : undefined,
      duration_min: Number(tr.duration) > 0 ? Math.round(Number(tr.duration)) : undefined,
      summary: clip([tr.summary?.overview, tr.summary?.short_summary].filter(Boolean).join("\n"), 2000),
      next_steps: actionItems(tr.summary?.action_items),
      transcript: clip(text, TRANSCRIPT_CAP),
      captured: ctx.now.toISOString(),
    });
  }
  return out;
}
