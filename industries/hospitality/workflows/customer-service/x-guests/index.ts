// The guests and waitlist workflow's two crons. The queue cron reads the waitlist and writes positions and quoted waits
// back to the sheet. The close cron logs each party that left the queue once, then queues the clearing of its row for
// approval. No cron messages a guest, and no cron clears a row. Judgment (a table, a VIP, a guest who asks to be moved)
// stays with the host, as SKILL.md describes.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { type Entry, type Settings, DONE, STATUSES, WHEN } from "./types.ts";
import * as g from "./adapters/google-workspace.ts";

/** The problem with a waitlist row, or null when it can be queued. */
function problem(e: Entry): string | null {
  if (!e.guest) return "guest name is missing";
  if (e.party === null || e.party > 100) return "party size must be a whole number from 1 to 100";
  if (!WHEN.test(e.added)) return "added needs a date, a time and an offset, such as 2026-12-05T18:00:00+11:00";
  return null;
}

/** A stable key for one party: its name, its time of joining and its size. */
const partyKey = (e: Entry) => safeKey(`${e.guest}|${e.added}|${e.party}`, 120);

/** Every 10 minutes: put each waiting party in order and quote its wait; mark rows that cannot be read Check. */
export async function queue(ctx: Ctx<Settings>) {
  g.checkSettings(ctx.settings);
  const per = ctx.settings.minutes_per_group ?? 15;
  const counts = { positioned: 0, check: 0 };
  const waiting: Entry[] = [];
  const writes: Entry[] = [];
  for (const e of await g.readWaitlist(ctx)) {
    if (!STATUSES.includes(e.status)) {
      writes.push({ ...e, status: "Check", position: null, quoted: null, note: "status must be Waiting, Ready, Seated, No show, Left or Check" });
      counts.check++;
      continue;
    }
    if (e.status === "Check") continue;                       // the host fixes these by hand
    if (e.status !== "Waiting") {
      if (e.position !== null || e.quoted !== null) writes.push({ ...e, position: null, quoted: null });
      continue;
    }
    const bad = problem(e);
    if (bad) { writes.push({ ...e, status: "Check", position: null, quoted: null, note: bad }); counts.check++; continue; }
    waiting.push(e);
  }
  waiting.sort((a, b) => Date.parse(a.added) - Date.parse(b.added) || a.row - b.row);
  waiting.forEach((e, i) => {
    const position = i + 1, quoted = i * per;
    if (e.position !== position || e.quoted !== quoted || e.note !== "") { writes.push({ ...e, position, quoted, note: "" }); counts.positioned++; }
  });
  for (const w of writes) await g.writeEntry(ctx, w);
  ctx.log(`queue: ${counts.positioned} positioned, ${counts.check} to check`);
  return counts;
}

/** Daily: log each party that was seated, marked no show or left, once to the guest log; queue clearing its row for approval. */
export async function close(ctx: Ctx<Settings>) {
  g.checkSettings(ctx.settings);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.settings.timezone }).format(ctx.now);
  const logs: unknown[][] = [];
  const fresh: string[] = [];
  const finished: { e: Entry; key: string }[] = [];
  let skipped = 0;
  for (const e of await g.readWaitlist(ctx)) {
    if (!DONE.includes(e.status)) continue;
    if (problem(e)) { skipped++; continue; }                  // left in place: a person fixes the row first
    const key = partyKey(e);
    finished.push({ e, key });
    if (await ctx.store.get("waitlog", key)) continue;        // already logged on an earlier run
    const mins = WHEN.test(e.outcome) ? Math.round((Date.parse(e.outcome) - Date.parse(e.added)) / 60000) : NaN;
    logs.push([today, e.guest, e.party, e.added, e.status, Number.isFinite(mins) && mins >= 0 ? mins : ""]);
    fresh.push(key);
  }
  // The log goes first: a failed append leaves nothing marked, so the next run logs the party again instead of losing it.
  await g.logRows(ctx, logs);
  for (const key of fresh) await ctx.store.put("waitlog", key, { logged: today });
  for (const { e, key } of finished) await g.queueClear(ctx, e, key);   // the approval de-duplicates: a re-run never queues twice
  ctx.log(`close: ${logs.length} logged, ${finished.length} queued for clearing, ${skipped} left for a person to fix`);
  return { logged: logs.length, queued: finished.length, skipped };
}

export const CRONS = { queue, close };
