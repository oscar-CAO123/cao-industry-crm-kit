// Fireflies: meetings its bot recorded, with the platform's own summary and action list. The one write is a recap share
// (mutation.shareMeeting), which emails the transcript to the addresses in settings. It only ever runs after approval.
// Field names: the GraphQL pages (Transcript, ShareMeetingInput).
import { createHash } from "node:crypto";
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Meeting, type Notetaker, type Settings, FIREFLIES_ID, clamp, cut, keyOf } from "../types.ts";

const P = "fireflies";
const SELECT = "id title dateString summary { overview short_summary action_items } meeting_attendees { displayName name }";

export const fireflies: Notetaker = {
  id: P,
  async meetings(ctx: Ctx<Settings>) {
    const since = new Date(ctx.now.getTime() - (ctx.settings.lookback_days ?? 14) * 864e5).toISOString();
    const limit = clamp(ctx.settings.fireflies?.limit ?? 50, 1, 50);
    const r = await ctx.draft<any>({ platform: P, op: "query.transcripts", summary: "read recent meetings",
      input: { params: { fromDate: since, limit }, select: SELECT } });
    const rows: any[] = Array.isArray(r.data?.data?.transcripts) ? r.data.data.transcripts : [];
    const out: Omit<Meeting, "status">[] = [];
    for (const t of rows) {
      const id = String(t?.id ?? "");
      if (!FIREFLIES_ID.test(id)) continue;
      const summary = [t.summary?.overview, t.summary?.short_summary]
        .filter((s: unknown) => typeof s === "string" && s.trim()).join("\n\n");
      const raw = t.summary?.action_items;
      const actionText = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("\n") : "";
      const title = cut(t.title || "Meeting", 200);
      out.push({
        key: keyOf(P, id), platform: P, id, title,
        when: typeof t.dateString === "string" ? cut(t.dateString, 40) : ctx.now.toISOString(),
        summary: cut(summary, 8000),
        attendees: (Array.isArray(t.meeting_attendees) ? t.meeting_attendees : [])
          .map((a: any) => cut(a?.displayName || a?.name, 120)).filter(Boolean).slice(0, 30),
        action_items_source: cut(actionText, 4000) || undefined,
        fingerprint: createHash("sha256").update(JSON.stringify([title, summary, actionText])).digest("hex").slice(0, 16),
      });
    }
    return out;
  },
  shareAct(m: Meeting, emails: string[], days: number): Act {
    if (!FIREFLIES_ID.test(m.id)) throw new Error("fireflies: bad meeting id");
    const expiry = [7, 14, 30].includes(days) ? days : 14;
    return { platform: P, op: "mutation.shareMeeting", summary: `share "${m.title}" with ${emails.length} address(es), link expires in ${expiry} days`,
      input: { params: { input: { meeting_id: m.id, emails: emails.slice(0, 50), expiry_days: expiry } } } };
  },
};
