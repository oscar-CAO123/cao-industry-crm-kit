// Fireflies: the list of recent meetings and the finished summary of each one. Read only.
// Field and argument names come from the vendor's docs (the transcripts and transcript
// queries and the Transcript type). Replies are GraphQL, so the data sits under data.<field>.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Meeting, Settings, Transcript } from "../types.ts";

const P = "fireflies";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
/** Strip control characters and cap the length of any text that came from a call. */
const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n);

function unwrap<T>(body: unknown): T {
  const b = body as { data?: T; errors?: { message?: string }[] } | undefined;
  if (b?.errors?.length) throw new Error(`fireflies: ${clip(b.errors[0]?.message, 160) || "request refused"}`);
  if (!b?.data) throw new Error("fireflies: no data in the reply");
  return b.data;
}

export const fireflies = {
  id: P,
  /** Meetings that started after `since`, newest first as Fireflies returns them. */
  async recentMeetings(ctx: Ctx<Settings>, since: Date, limit: number): Promise<Omit<Meeting, "status">[]> {
    const r = await ctx.draft<unknown>({ platform: P, op: "query.transcripts", summary: "list recent meetings", input: {
      params: { fromDate: since.toISOString(), limit: Math.min(Math.max(Math.floor(limit), 1), 50) },
      select: "id title dateString organizer_email" } });
    const rows = unwrap<{ transcripts?: Transcript[] | null }>(r.data).transcripts ?? [];
    return rows.filter((t) => ID.test(String(t.id ?? ""))).map((t) => ({
      id: String(t.id), title: clip(t.title || "Untitled meeting", 160), when: clip(t.dateString, 40),
      organizer: clip(t.organizer_email, 190) || undefined, attendees: [], attempts: 0,
    }));
  },
  /** One meeting's summary, attendees and transcript link. */
  async readMeeting(ctx: Ctx<Settings>, id: string): Promise<Transcript> {
    if (!ID.test(id)) throw new Error("fireflies: bad meeting id");
    const r = await ctx.draft<unknown>({ platform: P, op: "query.transcript", summary: "read meeting summary", input: {
      params: { id },
      select: "id title dateString organizer_email meeting_attendees { email name } summary { overview action_items keywords } transcript_url" } });
    const t = unwrap<{ transcript?: Transcript | null }>(r.data).transcript;
    if (!t) throw new Error("fireflies: meeting not found");
    return {
      ...t,
      summary: t.summary ? { overview: clip(t.summary.overview, 4000), action_items: clip(t.summary.action_items, 4000), keywords: t.summary.keywords ?? [] } : null,
    };
  },
};
