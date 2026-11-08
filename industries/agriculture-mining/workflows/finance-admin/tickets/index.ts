// The delivery tickets workflow's three crons. Each reads, drafts or queues; none sends. A person approves every QC email.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Ticket, problem, grade, hasSpec, text, cell, esc, day } from "./types.ts";
import { dockets, addRows, mailDraft } from "./adapters/microsoft-365.ts";

/** Every 15 minutes: docket emails in the ticket mailbox become new tickets, each once. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const m of await dockets(ctx)) {
    const key = safeKey(`mail:${m.id}`);
    if (await ctx.store.get<Ticket>("tickets", key)) continue;
    await ctx.store.put("tickets", key, { key, source: "mail", message_id: m.id, title: m.subject, received: m.received, status: "new" } satisfies Ticket);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: a new ticket with every field entered gets a register row. Anything incomplete is held, with the reason. */
export async function record(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Ticket>("tickets")).filter((t) => t.status === "new");
  let recorded = 0, held = 0;
  for (const t of todo) {
    const why = !t.docket_no ? "no docket fields yet: read the docket and enter them in the shell" : problem(t, ctx.settings.expected_grades);
    if (why) { held++; await ctx.store.put("tickets", t.key, { ...t, status: "held", reason: why }); continue; }
    await addRows(ctx, ctx.settings.microsoft_365.tickets, [[t.date, cell(t.docket_no), cell(text(t.carrier)), cell(text(t.supplier)),
      cell(text(t.site)), cell(t.spec), cell(text(t.grade)), t.net_tonnes, "Recorded"]], `register row for docket ${t.docket_no}`);
    await ctx.store.put("tickets", t.key, { ...t, status: "recorded", reason: undefined });
    recorded++;
  }
  ctx.log(`record: ${recorded} recorded, ${held} held`);
  return { recorded, held };
}

/** Hourly: a recorded ticket whose grade differs from the contract gets a QC row and a QC email queued for approval. */
export async function gradeCheck(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Ticket>("tickets")).filter((t) => t.status === "recorded");
  const m = ctx.settings.microsoft_365;
  let flagged = 0, cleared = 0;
  for (const t of todo) {
    if (!t.spec || !hasSpec(ctx.settings.expected_grades, t.spec)) { await ctx.store.put("tickets", t.key, { ...t, status: "held", reason: "spec is no longer in expected_grades" }); continue; }
    const expected = ctx.settings.expected_grades[t.spec];
    if (grade(t.grade) === grade(expected)) { cleared++; await ctx.store.put("tickets", t.key, { ...t, status: "cleared" }); continue; }
    if (m.qc) await addRows(ctx, m.qc, [[day(ctx.now), cell(t.docket_no), cell(text(t.carrier)), cell(t.spec), cell(text(t.grade)), cell(expected), "Open"]], `QC row for docket ${t.docket_no}`);
    const d = await mailDraft(ctx, { to: m.qc_contact, subject: `Grade check: docket ${t.docket_no}`,
      html: `<p>Docket ${esc(t.docket_no)} from ${esc(text(t.carrier))} at ${esc(text(t.site))} reads ${esc(text(t.grade))} for ${esc(t.spec)}. The contract grade is ${esc(expected)}. Please check the docket and its photos.</p>` });
    const id = await ctx.queue({ ...d.act, key: `qc:${t.key}` }, `QC email to ${m.qc_contact}: docket ${t.docket_no} reads ${text(t.grade)}, contract ${expected}`);
    await ctx.store.put("tickets", t.key, { ...t, status: "flagged", approval: id });
    flagged++;
  }
  ctx.log(`grade-check: ${flagged} flagged, ${cleared} cleared`);
  return { flagged, cleared };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, record, "grade-check": gradeCheck };
