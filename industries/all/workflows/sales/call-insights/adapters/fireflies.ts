// Fireflies: the notetaker's transcripts. Both calls are GraphQL queries, so both are reads.
// Field names are from Fireflies' GraphQL docs (the transcript and transcripts queries): id, title, date,
// organizer_email, participants, duration, summary { overview, short_summary, action_items }, sentences { speaker_name, text }.
// A GraphQL query needs a selection set, so every call names the fields it reads.
// Replies are the GraphQL envelope { data: {...} }, so the field is read out of data.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type CallRecord, type Settings, EMAIL, TRANSCRIPT_CAP, clip, cut, keyOf } from "../types.ts";

const P = "fireflies" as const;
const TID = /^[A-Za-z0-9_-]{4,80}$/;
const LIST_FIELDS = "id title date organizer_email participants duration";
const ONE_FIELDS = "id title date organizer_email participants duration summary { overview short_summary action_items } sentences { speaker_name text }";

/** A field of the GraphQL envelope. The error text is never copied out: it can hold client data. */
function field<T>(body: any, name: string): T | undefined {
  if (body?.errors?.length) throw new Error(`fireflies: ${name} query failed`);
  return body?.data?.[name] as T | undefined;
}

/** A transcript date (epoch milliseconds or a date string) as ISO text, or the fallback when it does not read as a date. */
function when(d: unknown, fallback: string): string {
  const t = typeof d === "number" ? new Date(d) : new Date(String(d ?? ""));
  return Number.isNaN(t.getTime()) ? fallback : t.toISOString();
}

/** Participant emails: lower case, valid, unique, without the organizer, at most ten. */
function attendeesOf(xs: unknown, organizer?: string): string[] {
  const seen = new Set<string>();
  for (const x of Array.isArray(xs) ? xs : []) {
    const e = String(x ?? "").trim().toLowerCase();
    if (e.length <= 254 && EMAIL.test(e) && e !== organizer) seen.add(e);
  }
  return [...seen].slice(0, 10);
}

/** Calls recorded since the watermark that are not stored yet. Reads only. */
export async function recent(ctx: Ctx<Settings>, since: string | undefined, max: number): Promise<CallRecord[]> {
  const listed = await ctx.draft<any>({ platform: P, op: "query.transcripts", summary: "list recent transcripts",
    input: { params: { limit: max, ...(since ? { fromDate: since } : {}) }, select: LIST_FIELDS } });
  const list = field<any[]>(listed.data, "transcripts") ?? [];
  const out: CallRecord[] = [];
  for (const t of list.slice(0, max)) {
    const id = String(t?.id ?? "");
    if (!TID.test(id)) continue;
    const key = keyOf(`${P}:${id}`);
    if (await ctx.store.get("calls", key)) continue;
    const one = await ctx.draft<any>({ platform: P, op: "query.transcript", summary: "read one transcript",
      input: { params: { id }, select: ONE_FIELDS } });
    const tr = field<any>(one.data, "transcript");
    if (!tr) continue;
    const organizer = typeof tr.organizer_email === "string" && EMAIL.test(tr.organizer_email.toLowerCase())
      ? tr.organizer_email.toLowerCase() : undefined;
    const text = (tr.sentences ?? []).map((s: any) => `${clip(s?.speaker_name, 80)}: ${cut(s?.text, 2000)}`).join("\n");
    out.push({
      key, platform: P, ref: id, title: clip(tr.title ?? "Call", 200),
      happened: when(tr.date, ctx.now.toISOString()),
      organizer, attendees: attendeesOf(tr.participants, organizer),
      duration_min: Number(tr.duration) > 0 ? Math.round(Number(tr.duration)) : undefined,
      summary: cut([tr.summary?.overview, tr.summary?.short_summary].filter(Boolean).join("\n"), 2000),
      transcript: cut(text, TRANSCRIPT_CAP),
      captured: ctx.now.toISOString(),
    });
  }
  return out;
}
