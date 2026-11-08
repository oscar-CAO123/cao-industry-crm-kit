// The client programs workflow's three crons. Each reads, drafts and queues. None sends. Writing a plan for a client
// with no saved template is coach judgment (SKILL.md); the crons only fill saved templates.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type AtRecord, RECORD_ID, EMAIL, DAY, WEEK } from "./types.ts";
import { airtable, listRecords, createRecord, updateRecord } from "./adapters/airtable.ts";
import { googleWorkspace, draftEmail, sendDraftAct } from "./adapters/google-workspace.ts";

const linked = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((x) => RECORD_ID.test(String(x)));

/** Every 30 minutes: a program row for each client whose intake is done and whose goal matches a saved template. */
export async function programDraft(ctx: Ctx<Settings>) {
  const s = ctx.settings, c = s.airtable.fields.clients, p = s.airtable.fields.programs;
  let drafted = 0, skipped = 0;
  for (const row of await listRecords(ctx, s.airtable.tables.clients)) {
    if (row.fields[c.status] !== s.statuses.intake_done) continue;
    if (await ctx.store.get("client-programs-drafted", row.id)) continue; // already drafted once: never a second program
    const goal = String(row.fields[c.goal] ?? "").toLowerCase();
    const tpl = (s.program_templates ?? []).find((t) => t.match && goal.includes(t.match.toLowerCase()));
    if (!tpl) { skipped++; continue; } // no saved template fits: the coach writes it
    const programId = await createRecord(ctx, s.airtable.tables.programs, {
      [p.client]: [row.id], [p.name]: tpl.name, [p.plan]: tpl.plan, [p.status]: "Draft" });
    await ctx.store.put("client-programs-drafted", row.id, { program: programId, at: ctx.now.toISOString() });
    await updateRecord(ctx, s.airtable.tables.clients, row.id, { [c.status]: s.statuses.program_drafted });
    drafted++;
  }
  ctx.log(`program-draft: ${drafted} drafted, ${skipped} need a coach`);
  return { drafted, needs_coach: skipped };
}

/** Daily: a check-in email draft for each active client with no logged session for the set number of days. The send is queued. */
export async function checkIn(ctx: Ctx<Settings>) {
  const s = ctx.settings, ci = s.check_in;
  if (!ci || !(ci.after_days > 0)) return { drafted: 0, reason: "check_in is not set" };
  const c = s.airtable.fields.clients, se = s.airtable.fields.sessions;
  const clients = await listRecords(ctx, s.airtable.tables.clients);
  const sessions = await listRecords(ctx, s.airtable.tables.sessions);
  const lastSession = new Map<string, number>();
  for (const x of sessions) {
    const at = Date.parse(String(x.fields[se.date] ?? ""));
    if (!Number.isFinite(at)) continue;
    for (const id of linked(x.fields[se.client])) lastSession.set(id, Math.max(lastSession.get(id) ?? 0, at));
  }
  // One check-in per client per window, so a re-run in the same window never queues twice.
  const window = Math.floor(ctx.now.getTime() / (ci.after_days * DAY));
  let drafted = 0;
  for (const row of clients as AtRecord[]) {
    if (row.fields[c.status] !== s.statuses.active) continue;
    const email = String(row.fields[c.email] ?? "").trim();
    if (!EMAIL.test(email)) continue;
    if (ctx.now.getTime() - (lastSession.get(row.id) ?? 0) < ci.after_days * DAY) continue;
    const key = `${row.id}:${window}`;
    if (await ctx.store.get("client-programs-checkins", key)) continue;
    const first = String(row.fields[c.name] ?? "").split(/\s+/)[0] || "there";
    const body = ci.body.split("{name}").join(first);
    const draftId = await draftEmail(ctx, { to: email, subject: ci.subject, body });
    await ctx.queue({ ...sendDraftAct(draftId, email), key: `checkin:${key}` }, `Send check-in to ${email}`);
    await ctx.store.put("client-programs-checkins", key, { draft: draftId, at: ctx.now.toISOString() });
    drafted++;
  }
  ctx.log(`check-in: ${drafted} drafted`);
  return { drafted };
}

/** Weekly: one progress row per active client, counting the sessions logged that week. */
export async function progressSummary(ctx: Ctx<Settings>) {
  const s = ctx.settings, c = s.airtable.fields.clients, se = s.airtable.fields.sessions, pr = s.airtable.fields.progress;
  const clients = await listRecords(ctx, s.airtable.tables.clients);
  const sessions = await listRecords(ctx, s.airtable.tables.sessions);
  const week = Math.floor(ctx.now.getTime() / WEEK);
  const from = ctx.now.getTime() - WEEK;
  let written = 0;
  for (const row of clients) {
    if (row.fields[c.status] !== s.statuses.active) continue;
    const key = `${row.id}:${week}`;
    if (await ctx.store.get("client-programs-progress", key)) continue;
    const mine = sessions.filter((x) => linked(x.fields[se.client]).includes(row.id));
    const recent = mine.filter((x) => { const at = Date.parse(String(x.fields[se.date] ?? "")); return at >= from && at <= ctx.now.getTime(); });
    const summary = `${recent.length} session${recent.length === 1 ? "" : "s"} logged in the last 7 days. ${mine.length} logged in total.`;
    await createRecord(ctx, s.airtable.tables.progress, { [pr.client]: [row.id], [pr.week]: ctx.now.toISOString().slice(0, 10), [pr.summary]: summary });
    await ctx.store.put("client-programs-progress", key, { at: ctx.now.toISOString() });
    written++;
  }
  ctx.log(`progress-summary: ${written} written`);
  return { written };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "program-draft": programDraft,
  "check-in": checkIn,
  "progress-summary": progressSummary,
};

// Adapters are imported so the platform list stays in one place; both are docs-only until a sandbox proves them.
export const ADAPTERS = { airtable, "google-workspace": googleWorkspace };
