// The file-notes workflow's two crons. Each reads Fireflies and writes a draft into the workflow store.
// Nothing is filed on a client record, shared or sent: a draft waits in the store until an adviser files it by hand.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { fireflies } from "./adapters/fireflies.ts";
import type { FileNote, Meeting, Settings, Transcript } from "./types.ts";

const DAY = 864e5;
const MAX_CHECKS = 6;

/** Every 15 minutes: meetings from the last few days that have not been seen before. */
export async function intake(ctx: Ctx<Settings>) {
  const since = new Date(ctx.now.getTime() - (ctx.settings.lookback_days ?? 2) * DAY);
  let added = 0;
  for (const m of await fireflies.recentMeetings(ctx, since, ctx.settings.max_per_run ?? 20)) {
    if (await ctx.store.get("meetings", m.id)) continue; // seen before: a re-run never adds it twice
    await ctx.store.put("meetings", m.id, { ...m, status: "new" } satisfies Meeting);
    added++;
  }
  ctx.log(`intake: ${added} new meetings`);
  return { added };
}

/** The draft text. It says plainly that it is a draft and was not checked against the transcript. */
function noteBody(s: Settings, m: Meeting, t: Transcript, attendees: string[], overview: string, actions: string): string {
  return [
    "DRAFT FILE NOTE. Not filed. The adviser checks it and files it by hand.",
    `Meeting: ${m.title}`,
    `Date: ${m.when || "not recorded"}`,
    `Adviser: ${s.adviser || "not set"}`,
    `Attendees: ${attendees.join(", ") || "not recorded"}`,
    "",
    "Summary (taken from the Fireflies summary, not checked against the transcript):",
    overview || "None.",
    "",
    "Action items:",
    actions || "None.",
    "",
    `Transcript: ${t.transcript_url || "not available"}`,
  ].join("\n");
}

/** Every 30 minutes: draft a file note for each new meeting from its own summary. The draft waits for a person. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Meeting>("meetings")).filter((m) => m.status === "new");
  let drafted = 0, waiting = 0;
  for (const m of todo) {
    const t = await fireflies.readMeeting(ctx, m.id);
    const overview = String(t.summary?.overview ?? "").trim();
    const actions = String(t.summary?.action_items ?? "").trim();
    if (!overview && !actions) {
      // The summary is not ready yet (a live or very short meeting). Check again on the next run, and stop after a few checks.
      const attempts = m.attempts + 1;
      await ctx.store.put("meetings", m.id, attempts >= MAX_CHECKS
        ? { ...m, attempts, status: "skipped", reason: "no summary after several checks" }
        : { ...m, attempts, reason: "summary not ready" } satisfies Meeting);
      waiting++;
      continue;
    }
    const attendees = (t.meeting_attendees ?? [])
      .map((a) => String(a?.name || a?.email || "").slice(0, 120)).filter(Boolean).slice(0, 30);
    const note: FileNote = { meeting: m.id, title: m.title, when: m.when, body: noteBody(ctx.settings, m, t, attendees, overview, actions), status: "draft", created: ctx.now.toISOString() };
    await ctx.store.put("notes", m.id, note);                                // write the note first, then mark the meeting
    await ctx.store.put("meetings", m.id, { ...m, status: "drafted", reason: undefined } satisfies Meeting);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${waiting} waiting for a summary`);
  return { drafted, waiting };
}

export const CRONS = { intake, draft };
