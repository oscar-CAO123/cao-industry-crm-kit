// The proof-of-delivery workflow's three crons. Each reads Onfleet and writes only the workflow's own register;
// the one thing that reaches a customer (a re-attempt task) is queued for a person to approve.
import type { Ctx, Approval } from "../../../../../../core/workflows/runtime.ts";
import type { Pod, Settings } from "./types.ts";
import * as onfleet from "./adapters/onfleet.ts";

const DAY = 864e5, HOUR = 36e5;
const POD = "pods", CURSOR = "cursor";
const CHECK_CAP = 100; // tasks re-read per needs-proof run

/** Every 15 minutes: completed stops since the last run go into the proof register. Read and store only. */
export async function pods(ctx: Ctx<Settings>) {
  // lookback_days must be a whole number of days, 1 to 365; anything else falls back to 30.
  const days = Number.isInteger(ctx.settings.lookback_days) && ctx.settings.lookback_days! >= 1 && ctx.settings.lookback_days! <= 365 ? ctx.settings.lookback_days! : 30;
  const floor = ctx.now.getTime() - days * DAY;
  const cur = await ctx.store.get<{ from: number; lastId?: string }>(CURSOR, "onfleet");
  // The saved cursor is used only if it is a sane past time inside the look-back window; otherwise the window's start.
  const saved = cur?.from;
  const from = Number.isSafeInteger(saved) && saved! > floor && saved! <= ctx.now.getTime() ? saved! : floor;
  const cap = ctx.settings.max_pages ?? 10;
  let lastId = cur?.lastId, newest = from, pages = 0, added = 0, skipped = 0;
  do {
    const page = await onfleet.listCompleted(ctx, from, lastId);
    pages++;
    for (const t of page.tasks) {
      const pod = onfleet.toPod(t, ctx.now);
      if (!pod) { skipped++; continue; }
      newest = Math.max(newest, Date.parse(pod.completed));
      if (await ctx.store.get<Pod>(POD, pod.key)) continue; // already in the register: the overlap at the edge of a run
      await ctx.store.put(POD, pod.key, pod);
      added++;
    }
    lastId = page.lastId;
  } while (lastId && pages < cap);
  // A run cut short keeps its place (same from, lastId) so the next run carries on; a finished run moves on to the newest completion.
  await ctx.store.put(CURSOR, "onfleet", lastId ? { from, lastId } : { from: newest });
  ctx.log(`pods: ${added} added, ${skipped} without a completion time, ${pages} page(s)`);
  return { added, skipped, pages, more: !!lastId };
}

/** Hourly: a completed stop with no photo or signature, past the grace period, is read again and flagged if still bare. */
export async function needsProof(ctx: Ctx<Settings>) {
  const grace = (ctx.settings.proof_grace_hours ?? 2) * HOUR;
  const waiting = Object.values(await ctx.store.list<Pod>(POD))
    .filter((p) => p.status === "needs-proof" && ctx.now.getTime() - Date.parse(p.completed) >= grace)
    .slice(0, CHECK_CAP);
  let cleared = 0, flagged = 0, unreadable = 0;
  for (const p of waiting) {
    const task = await onfleet.getTask(ctx, p.task_id);
    const fresh = onfleet.toPod(task, ctx.now);
    if (!fresh) { unreadable++; await ctx.store.put(POD, p.key, { ...p, status: "needs-check", checked: ctx.now.toISOString() } satisfies Pod); continue; }
    const next: Pod = { ...p, photo_count: fresh.photo_count, photo_ids: fresh.photo_ids, signature: fresh.signature,
      notes: fresh.notes, failed: fresh.failed, failure_reason: fresh.failure_reason, status: fresh.status, checked: ctx.now.toISOString() };
    await ctx.store.put(POD, p.key, next);
    if (next.status === "complete") cleared++; else if (next.status === "needs-proof") flagged++;
  }
  ctx.log(`needs-proof: ${flagged} still without proof, ${cleared} now complete, ${unreadable} unreadable`);
  return { checked: waiting.length, flagged, cleared, unreadable };
}

/** Hourly: a failed stop queues a re-attempt task for approval. The approval runs the create; nothing here does. */
export async function reattempt(ctx: Ctx<Settings>) {
  if (ctx.settings.reattempt === false) return { queued: 0, off: true };
  const all = Object.values(await ctx.store.list<Pod>(POD)).filter((p) => p.failed);
  let queued = 0, recorded = 0, skipped = 0;
  for (const p of all) {
    if (p.status === "reattempt-created" || p.status === "reattempt-rejected") continue;
    if (p.approval) {
      // Read the outcome from the store, never by guessing: the created task id is in the approval's results.
      const ap = await ctx.store.get<Approval>("approvals", p.approval);
      if (ap?.status === "done") {
        const id = ap.results?.map((r) => r.ref?.id).find((x) => typeof x === "string");
        await ctx.store.put(POD, p.key, id ? { ...p, status: "reattempt-created", reattempt_task: id } satisfies Pod : { ...p, status: "needs-check" } satisfies Pod);
        recorded++;
      } else if (ap?.status === "rejected") {
        await ctx.store.put(POD, p.key, { ...p, status: "reattempt-rejected" } satisfies Pod);
        recorded++;
      }
      continue; // pending, running or failed: a person acts on it in the CRM shell
    }
    if (!p.destination_id) { skipped++; ctx.log(`reattempt: ${p.short_id ?? p.task_id} has no destination id to re-attempt`); continue; }
    const id = await ctx.queue(onfleet.reattemptAct(p));
    await ctx.store.put(POD, p.key, { ...p, status: "reattempt-queued", approval: id } satisfies Pod);
    queued++;
  }
  ctx.log(`reattempt: ${queued} queued for approval, ${recorded} outcomes recorded, ${skipped} skipped`);
  return { queued, recorded, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pods, "needs-proof": needsProof, reattempt };
