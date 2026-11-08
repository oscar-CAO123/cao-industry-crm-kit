// The approvals workflow's two crons. Each one reads or drafts; none sends, lodges or changes a status.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { bluebeam } from "./adapters/bluebeam.ts";
import { documents, keyOf, dayOf, type Settings, type StatusRecord } from "./types.ts";

const STATUS = "approval-status";
const SNAPSHOTS = "snapshots";
// A markup counts as closed when its status says so. Statuses are free text from the platform, so this is a plain check.
const CLOSED = /^(closed|resolved|complete|completed|accepted|done)$/i;

/** Every hour: read the open markups and RFI-style requests on each approval document and record where each stands. */
export async function trackStatus(ctx: Ctx<Settings>) {
  let open = 0;
  const docs = documents(ctx.settings);
  for (const d of docs) {
    const rows = await bluebeam.markups(ctx, d);
    const statuses_valid = await bluebeam.statuses(ctx, d);
    const left = rows.filter((r) => !CLOSED.test(r.status));
    const rec: StatusRecord = {
      key: keyOf(d), label: d.label ?? "document", checked: ctx.now.toISOString(),
      markups: rows.length, open: left.length, open_rfis: left.filter((r) => /\bRFI\b/i.test(r.subject)).length,
      statuses_valid, open_items: left.slice(0, 100),
    };
    await ctx.store.put(STATUS, rec.key, rec);
    open += left.length;
  }
  ctx.log(`track-status: ${docs.length} documents, ${open} open`);
  return { documents: docs.length, open };
}

/** Daily: one dated snapshot of each approval document, kept in the Studio session for the record. Once per day per document. */
export async function recordKeeping(ctx: Ctx<Settings>) {
  let made = 0, skipped = 0;
  for (const d of documents(ctx.settings)) {
    const key = `${keyOf(d)}.${dayOf(ctx.now)}`;
    if (await ctx.store.get(SNAPSHOTS, key)) { skipped++; continue; }   // a re-run never snapshots the same day twice
    const r = await bluebeam.snapshot(ctx, d);
    if (r.status < 300) await ctx.store.put(SNAPSHOTS, key, { at: ctx.now.toISOString(), status: r.status });
    made++;
  }
  ctx.log(`record-keeping: ${made} snapshots, ${skipped} already done today`);
  return { snapshots: made, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "track-status": trackStatus, "record-keeping": recordKeeping };
