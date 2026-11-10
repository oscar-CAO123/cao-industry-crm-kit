// The job-tracking workflow's three crons. Each reads, drafts internal notes, and queues anything a client or follower sees.
// None of them sends. Judgment (what a stall means, what to tell a client) stays with the person who approves the queue.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Adapter, Platform, Settings, Tracked } from "./types.ts";
import { DAY, keyOf, oneLine } from "./types.ts";
import { servicem8 } from "./adapters/servicem8.ts";
import { asana } from "./adapters/asana.ts";

export const ADAPTERS: Record<Platform, Adapter> = { servicem8, asana };

/** The status in plain words for a client. */
const plain = (s: string) => ({ Quote: "being quoted", "Work Order": "booked in", "In progress": "in progress", Completed: "complete", Unsuccessful: "closed" } as Record<string, string>)[s] ?? s.toLowerCase();

/** Every 30 minutes: open jobs and projects from each intake platform go on the tracking record, once each. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const p of ctx.settings.intake) {
    for (const j of await ADAPTERS[p].open(ctx)) {
      if (await ctx.store.get<Tracked>("tracked", j.key)) continue;
      await ctx.store.put("tracked", j.key, { ...j, opened: ctx.now.toISOString() } satisfies Tracked);
      added++;
    }
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Daily, 8 or 9 am in eastern Australia: a stalled job gets one draft note; new progress gets one queued client message. */
export async function progress(ctx: Ctx<Settings>) {
  const stall = ctx.settings.stall_days ?? 5, every = ctx.settings.client_update_days ?? 7;
  const now = ctx.now.getTime();
  let stalled = 0, queued = 0;
  for (const old of Object.values(await ctx.store.list<Tracked>("tracked"))) {
    if (old.closed) continue;
    const a = ADAPTERS[old.platform];
    const t: Tracked = { ...old, ...(await a.refresh(ctx, old)) };
    const idle = t.last_activity ? (now - Date.parse(t.last_activity)) / DAY : 0;
    if (idle >= stall && !t.stalled) {
      await a.note(ctx, t, `No change for ${Math.floor(idle)} days. Status: ${t.status}. Check it and update the team.`);
      t.stalled = true;
      stalled++;
    } else if (idle < stall) t.stalled = false;

    const since = Date.parse(t.last_client_update ?? t.opened);
    const newProgress = !!t.last_activity && Date.parse(t.last_activity) > since;
    if (newProgress && (now - since) / DAY >= every && t.status !== "Completed" && t.status !== "Unsuccessful") {
      const id = await a.clientMessage(ctx, t, `Update on ${oneLine(t.title, 120)}`,
        `Hi ${t.contact.name ?? "there"}, here is a quick update on ${t.title}. It is ${plain(t.status)}. Reply to this message if you have questions.`,
        keyOf(`progress:${t.key}:${ctx.now.toISOString().slice(0, 10)}`));
      if (id) { t.last_client_update = ctx.now.toISOString(); queued++; }
    }
    await ctx.store.put("tracked", t.key, t);
  }
  ctx.log(`progress: ${stalled} stalled, ${queued} client messages queued`);
  return { stalled, queued };
}

/** Hourly, at five past: a finished job gets a draft close-out note and a queued completion message; an unsuccessful one closes quietly. */
export async function closeOut(ctx: Ctx<Settings>) {
  let closed = 0;
  for (const old of Object.values(await ctx.store.list<Tracked>("tracked"))) {
    if (old.closed) continue;
    const a = ADAPTERS[old.platform];
    const t: Tracked = { ...old, ...(await a.refresh(ctx, old)) };
    if (t.status === "Completed") {
      await a.note(ctx, t, `Finished on ${ctx.now.toISOString().slice(0, 10)}. Check the final time, materials and invoice before closing it out.`);
      await a.clientMessage(ctx, t, `Your job is complete: ${oneLine(t.title, 120)}`,
        `Hi ${t.contact.name ?? "there"}, ${t.title} is complete. Thank you for working with ${ctx.settings.business_name ?? "us"}.`,
        keyOf(`complete:${t.key}`));
      t.closed = ctx.now.toISOString();
      closed++;
    } else if (t.status === "Unsuccessful") {
      t.closed = ctx.now.toISOString();
      closed++;
    }
    await ctx.store.put("tracked", t.key, t);
  }
  ctx.log(`close-out: ${closed} closed`);
  return { closed };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, progress, "close-out": closeOut };
