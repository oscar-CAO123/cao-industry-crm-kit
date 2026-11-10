// The internal handoffs workflow's three crons. Each one reads, drafts and queues; none sends.
// Judgment (picking the person for a handover no route covers) belongs to the agent skill in SKILL.md, which writes a
// proposal into the store. The crons turn a route or a proposal into a record task, then queue the handover itself.
import type { Act, Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Handover, type Settings, HOUR, checkProposal, checkRoute, clip, dueDate, handoverText, keyOf, pickRoute } from "./types.ts";
import { asana } from "./adapters/asana.ts";
import { slack } from "./adapters/slack.ts";

type Who = { assignee: string; slack_user?: string; due_days: number; summary: string; next_step?: string };

/** Every 15 minutes: new requests from the Asana intake project and the Slack handover channel. Each is stored once. */
export async function intake(ctx: Ctx<Settings>) {
  const found: Omit<Handover, "status" | "chased">[] = [];
  if (ctx.settings.asana?.intake_project_gid) found.push(...(await asana.requests(ctx)));
  let cursorKey = "", newest: string | undefined;
  if (ctx.settings.slack?.channel) {
    cursorKey = keyOf(`cursor:slack:${ctx.settings.slack.channel}`);
    const saved = await ctx.store.get<{ ts: string }>("cursors", cursorKey);
    const got = await slack.requests(ctx, saved?.ts);
    found.push(...got.rows);
    newest = got.newest;
  }
  let added = 0;
  for (const h of found) {
    if (await ctx.store.get("handovers", h.id)) continue;
    await ctx.store.put("handovers", h.id, { ...h, status: "new", chased: [] } satisfies Handover);
    added++;
  }
  // The cursor moves only after the rows are stored, so a failed run is read again rather than lost.
  if (cursorKey && newest) await ctx.store.put("cursors", cursorKey, { ts: newest });
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: route each new handover, record it as an unassigned Asana task, and queue the handover for approval. */
export async function draft(ctx: Ctx<Settings>) {
  if (!ctx.settings.asana?.record_project_gid) throw new Error("internal-handoffs: asana.record_project_gid is not set");
  const todo = Object.values(await ctx.store.list<Handover>("handovers")).filter((h) => h.status === "new" || h.status === "needs-routing");
  let queued = 0, needs_routing = 0;
  for (const h of todo) {
    const park = async (reason: string) => {
      needs_routing++;
      // Reads the saved row, so a record task saved earlier in this run is kept when the handover is parked.
      const cur = (await ctx.store.get<Handover>("handovers", h.id)) ?? h;
      await ctx.store.put("handovers", h.id, { ...cur, status: "needs-routing", reason } satisfies Handover);
    };
    try {
      const got = await ctx.store.get<unknown>("proposals", h.id);
      let who: Who;
      if (got !== undefined) {
        const p = checkProposal(got);
        if (typeof p === "string") { await park(p); continue; }
        who = { assignee: p.assignee, slack_user: p.slack_user, due_days: p.due_days ?? 2, summary: p.summary, next_step: p.next_step };
      } else {
        const r = pickRoute(ctx.settings.routes, `${h.title} ${h.text}`);
        if (!r) { await park("no route matches and no proposal yet: the agent picks the person"); continue; }
        const c = checkRoute(r);
        if (typeof c === "string") { await park(c); continue; }
        who = { assignee: c.assignee, slack_user: c.slack_user, due_days: c.due_days ?? 2, summary: clip(h.text, 1000) || h.title };
      }

      const due = dueDate(ctx.now, who.due_days);
      // The record task is made once; a retry after a crash reuses it. Its direct message is opened once too.
      const rec: { task: string; channel?: string } = h.record ?? { task: "" };
      if (!rec.task) {
        rec.task = await asana.createRecord(ctx, `Handover: ${h.title}`, handoverText(h.title, due, who.summary, who.next_step));
        // Saved before the direct message: if that step fails, the next run reuses this task instead of making another.
        await ctx.store.put("handovers", h.id, { ...h, record: rec } satisfies Handover);
      }
      if (who.slack_user && !rec.channel) rec.channel = await slack.dm(ctx, who.slack_user);
      await ctx.store.put("handovers", h.id, { ...h, record: rec, reason: undefined } satisfies Handover);

      const body = handoverText(h.title, due, who.summary, who.next_step);
      const acts: Act[] = [asana.assignAct(rec.task, who.assignee, due, h.title), asana.noteAct(rec.task, body, `note on "${clip(h.title, 80)}"`)];
      if (rec.channel) acts.push(slack.postAct(rec.channel, body, `message ${who.assignee} in Slack`));
      // The first act carries the key, so a cron that runs again finds the same approval and never queues it twice.
      const approval = await ctx.queue(
        acts.map((a, i) => (i === 0 ? { ...a, key: keyOf(`handover:${h.id}`) } : a)),
        `hand "${clip(h.title, 80)}" to ${who.assignee}, due ${due}`);
      await ctx.store.put("handovers", h.id, { ...h, status: "queued", reason: undefined, record: rec, approval,
        route: { assignee: who.assignee, slack_user: who.slack_user, due } } satisfies Handover);
      queued++;
    } catch (e: any) {
      await park(clip(e?.message ?? e, 200));
    }
  }
  ctx.log(`draft: ${queued} queued, ${needs_routing} need routing`);
  return { queued, needs_routing };
}

/** Daily: mark handovers passed on once their approval runs, record acknowledgements and completions, queue due chases,
 *  and queue one status post for the open handovers. A chase never repeats: it is numbered and keyed. */
export async function followUp(ctx: Ctx<Settings>) {
  const chases = ctx.settings.chase_after_hours ?? [24, 72];
  let passed = 0, chased = 0, acknowledged = 0, closed = 0;
  for (let h of Object.values(await ctx.store.list<Handover>("handovers"))) {
    if (h.status === "queued" && h.approval) {
      const ap = await ctx.store.get<Approval>("approvals", h.approval);
      // A refused handover leaves the open list and is never retried by a cron.
      if (ap?.status === "failed" || ap?.status === "rejected") {
        await ctx.store.put("handovers", h.id, { ...h, status: ap.status, reason: ap.error ?? `approval ${ap.status}` } satisfies Handover);
        continue;
      }
      if (ap?.status !== "done") continue;
      h = { ...h, status: "passed-on", passed_on: ap.decided ?? ctx.now.toISOString() };
      await ctx.store.put("handovers", h.id, h);
      passed++;
    }
    if (h.status !== "passed-on" || !h.record?.task || !h.passed_on) continue;
    const st = await asana.state(ctx, h.record.task);
    if (st.completed) { await ctx.store.put("handovers", h.id, { ...h, status: "done" } satisfies Handover); closed++; continue; }
    if (st.answered) { await ctx.store.put("handovers", h.id, { ...h, status: "acknowledged" } satisfies Handover); acknowledged++; continue; }
    const n = h.chased.length;
    if (n >= chases.length) continue;
    if (ctx.now.getTime() - Date.parse(h.passed_on) < chases[n] * HOUR) continue;
    const act = asana.noteAct(h.record.task,
      `Still open: "${clip(h.title, 200)}" was handed to you on ${h.passed_on.slice(0, 10)}. Reply on this task, or mark it complete once it is picked up.`,
      `chase "${clip(h.title, 80)}" (${n + 1})`, keyOf(`chase:${h.id}:${n + 1}`));
    await ctx.queue(act);
    await ctx.store.put("handovers", h.id, { ...h, chased: [...h.chased, ctx.now.toISOString()] } satisfies Handover);
    chased++;
  }

  let status_queued = false;
  const channel = ctx.settings.slack?.channel;
  const open = Object.values(await ctx.store.list<Handover>("handovers")).filter((h) => h.status === "queued" || h.status === "passed-on");
  if (channel && open.length) {
    const day = ctx.now.toISOString().slice(0, 10);
    const lines = open.slice(0, 10).map((h) => `- ${clip(h.title, 80)} (${h.route?.assignee ?? "unassigned"})`);
    const more = open.length > 10 ? [`and ${open.length - 10} more`] : [];
    const text = [`Handovers open: ${open.length}`, ...lines, ...more].join("\n");
    await ctx.queue(slack.postAct(channel, text, `daily handover status for ${day}`, keyOf(`status:${day}`)));
    status_queued = true;
  }
  ctx.log(`follow-up: ${passed} passed on, ${chased} chased, ${acknowledged} acknowledged, ${closed} closed`);
  return { passed, chased, acknowledged, closed, status_queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, "follow-up": followUp };
