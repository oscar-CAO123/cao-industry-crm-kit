// The meeting-actions workflow's two crons. Each one reads, drafts or queues; none shares anything on its own.
// Judgment (reading a Granola transcript and writing its actions into the proposals namespace) belongs to the agent skill
// in SKILL.md. The draft cron turns a platform's own action list, or a valid proposal, into a meeting's actions, flags
// overdue ones, and queues a recap share for approval.
import type { Action, Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Meeting, type Notetaker, type Platform, type Proposal, type Settings, EMAIL, actionsFromLines, checkProposal, day } from "./types.ts";
import { fireflies } from "./adapters/fireflies.ts";
import { granola } from "./adapters/granola.ts";

const NOTETAKERS: Record<Platform, Notetaker> = { fireflies, granola };

/** Every 15 minutes: meetings from each notetaker, each stored once. A changed meeting is read again; nothing is written to any platform. */
export async function capture(ctx: Ctx<Settings>) {
  let added = 0, refreshed = 0;
  for (const p of ctx.settings.meeting_sources ?? []) {
    const src = NOTETAKERS[p];
    if (!src) throw new Error(`meeting-actions: no notetaker adapter for ${p}`);
    for (const m of await src.meetings(ctx)) {
      const cur = await ctx.store.get<Meeting>("meetings", m.key);
      if (!cur) { await ctx.store.put("meetings", m.key, { ...m, status: "new" } satisfies Meeting); added++; continue; }
      if (cur.fingerprint === m.fingerprint) continue;
      await ctx.store.put("meetings", m.key, { ...cur, ...m, status: cur.status === "drafted" ? "new" : cur.status } satisfies Meeting);
      refreshed++;
    }
  }
  ctx.log(`capture: ${added} new, ${refreshed} changed`);
  return { added, refreshed };
}

/** Every 30 minutes: each meeting gets its actions (from the platform or a valid proposal), and a recap share is queued for approval.
 *  A meeting with no usable actions is parked as needs-notes for the agent. Overdue actions are counted on every drafted meeting. */
export async function draft(ctx: Ctx<Settings>) {
  const max = ctx.settings.max_actions ?? 20;
  const today = day(ctx.now);
  const all = await ctx.store.list<Meeting>("meetings");
  const todo = Object.values(all).filter((m) => m.status === "new" || m.status === "needs-notes");
  const emails = (ctx.settings.recap_to ?? []).filter((e) => EMAIL.test(e)).slice(0, 50);
  let drafted = 0, needs_notes = 0, queued = 0;
  for (const m of todo) {
    const got = await ctx.store.get<Proposal>("proposals", m.key);
    const prop = got === undefined ? undefined : checkProposal(got, max);
    let actions: Action[] | undefined, summary = m.summary;
    if (prop && typeof prop !== "string") { actions = prop.actions; summary = prop.summary || m.summary; }
    else if (m.action_items_source) actions = actionsFromLines(m.action_items_source, max);
    if (!actions?.length) {
      needs_notes++;
      const reason = typeof prop === "string" ? `proposal not usable: ${prop}` : "no action items from the platform: the agent skill writes them";
      await ctx.store.put("meetings", m.key, { ...m, status: "needs-notes", reason } satisfies Meeting);
      continue;
    }
    const next: Meeting = { ...m, summary, status: "drafted", reason: undefined, actions, overdue: actions.filter((a) => a.due && a.due < today).length };
    const src = NOTETAKERS[m.platform];
    if (emails.length && src.shareAct) {
      next.approval = await ctx.queue({ ...src.shareAct(m, emails, ctx.settings.recap_expiry_days ?? 14), key: `share:${m.key}` },
        `Share "${m.title}" with ${emails.join(", ")}`);
      queued++;
    }
    await ctx.store.put("meetings", m.key, next satisfies Meeting);
    drafted++;
  }
  // Overdue counts on meetings drafted earlier: the due dates move with the calendar, not with the platform.
  let overdue_total = 0;
  for (const m of Object.values(all)) {
    if (m.status !== "drafted" || !m.actions) continue;
    if (todo.some((t) => t.key === m.key)) continue;
    const n = m.actions.filter((a) => a.due && a.due < today).length;
    overdue_total += n;
    if (n !== (m.overdue ?? 0)) await ctx.store.put("meetings", m.key, { ...m, overdue: n } satisfies Meeting);
  }
  ctx.log(`draft: ${drafted} drafted, ${needs_notes} need notes, ${queued} recap shares queued`);
  return { drafted, needs_notes, queued, overdue_total };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { capture, draft };
