// The tender reader's three crons. Each is deterministic: it reads, logs and drafts; it never sends.
// Judgment (go or no-go, scope, the rates and the proposal) belongs to the person in SKILL.md; the crons only read and record.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { MAX_ROWS, day, esc, keyOf, tenderRef, type MarkupRow, type Settings, type Tender } from "./types.ts";
import * as m365 from "./adapters/microsoft-365.ts";
import * as bb from "./adapters/bluebeam.ts";

/** Every 30 minutes: log each new tender notice in the bid register. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const n of await m365.tenderNotices(ctx)) {
    const id = keyOf(`m365:${n.id}`);
    if (await ctx.store.get("tenders", id)) continue;
    const t: Tender = {
      id, title: n.title, sender: n.sender, received: n.received || ctx.now.toISOString(),
      ref: { message_id: n.id, tender_ref: tenderRef(n.title) ?? tenderRef(n.text) }, status: "logged", updated: ctx.now.toISOString(),
    };
    await m365.logRegister(ctx, t);            // logged first: if this fails, the notice is tried again on the next run
    await ctx.store.put("tenders", id, t);
    added++;
  }
  ctx.log(`intake: ${added} logged`);
  return { added };
}

/** Every hour: start a markup list for each tender whose plan is in the Bluebeam project, then write its rows once Bluebeam returns them. */
export async function takeoff(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Tender>("tenders")).filter((t) => t.status === "logged" || t.status === "markup-running");
  if (!todo.length) return { drafted: 0, waiting: 0 };
  const files = await bb.planFiles(ctx);
  const maxPolls = ctx.settings.bluebeam?.max_polls ?? 8;
  const save = async (t: Tender, status: Tender["status"]) => { t.status = status; t.updated = ctx.now.toISOString(); await ctx.store.put("tenders", t.id, t); };
  let drafted = 0, waiting = 0;
  for (const t of todo) {
    if (!t.ref.plan_file_id) {
      const want = t.ref.tender_ref?.toLowerCase();
      const hit = want ? files.find((f) => f.Name.toLowerCase().includes(want)) : undefined;
      if (!hit) { waiting++; continue; }   // plans not in Bluebeam yet: looked at again on the next run
      t.ref.plan_file_id = String(hit.Id);
    }
    const fileId = Number(t.ref.plan_file_id);
    if (!t.ref.markup_job_id) {
      t.ref.markup_job_id = String(await bb.startMarkups(ctx, fileId));
      t.ref.markup_polls = 0;
      await save(t, "markup-running");
      waiting++;
      continue;
    }
    let found: any[] | undefined;
    try {
      found = await bb.markups(ctx, fileId, Number(t.ref.markup_job_id));
    } catch (e: any) {
      ctx.log(`takeoff: ${t.id.slice(0, 12)} markup read failed: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    if (!found) {
      t.ref.markup_polls = (t.ref.markup_polls ?? 0) + 1;
      await save(t, t.ref.markup_polls >= maxPolls ? "needs-check" : "markup-running");
      waiting++;
      continue;
    }
    const rows: MarkupRow[] = found.slice(0, MAX_ROWS).map((x) => ({
      page: Number(x.Page) || 0, type: String(x.Type ?? ""), subject: String(x.Subject ?? ""), comment: String(x.Comment ?? ""),
      author: x.Author ? String(x.Author) : undefined, created: x.DateCreated ? String(x.DateCreated).slice(0, 10) : undefined,
    }));
    await m365.takeoffRows(ctx, t, rows);
    await save(t, "takeoff-drafted");
    drafted++;
  }
  ctx.log(`takeoff: ${drafted} drafted, ${waiting} waiting`);
  return { drafted, waiting };
}

/** Daily: draft the tender digest to the estimator and queue its send for approval. One digest per day. */
export async function digest(ctx: Ctx<Settings>) {
  const tenders = Object.values(await ctx.store.list<Tender>("tenders"));
  if (!tenders.length) return { queued: 0 };
  const key = `digest:${day(ctx.now)}`;
  if (await ctx.store.get("approvals", approvalId(ctx.workflow.id, key))) return { queued: 0 };
  const rows = [...tenders].sort((a, b) => b.received.localeCompare(a.received)).slice(0, 100)
    .map((t) => `<tr><td>${esc(t.title)}</td><td>${esc(t.received.slice(0, 10))}</td><td>${esc(t.status)}</td></tr>`).join("");
  const html = `<p>Tenders logged so far, newest first. The takeoff rows for each plan are in the takeoff sheet.</p>`
    + `<table cellpadding="4"><tr><th align="left">Tender</th><th align="left">Received</th><th align="left">Status</th></tr>${rows}</table>`;
  const d = await m365.digestDraft(ctx, `Tender digest ${day(ctx.now)}`, html);
  const id = await ctx.queue({ ...d.act, key }, `${d.act.summary} (${tenders.length} tenders)`);
  ctx.log(`digest: queued ${id}`);
  return { queued: 1, approval: id };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, takeoff, digest };
