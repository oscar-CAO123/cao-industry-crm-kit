// The batches and landed costs workflow's three crons. Each reads and records, or queues for approval; none sends
// or changes stock by itself. Spreading landed costs across lines is not automated (see workflow.json gaps).
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import type { ReceiptLine, Settings, Proposal, StockSnapshot } from "./types.ts";
import { receivedLines, serialRecords, stockFor, snapshot, queueAdjustment } from "./adapters/cin7.ts";

/** Every 30 minutes: record each received purchase-order line with its PO freight and surcharge. */
export async function receive(ctx: Ctx<Settings>) {
  let added = 0;
  for (const l of await receivedLines(ctx)) {
    if (await ctx.store.get("receipts", l.key)) continue; // keep the first record of a line
    await ctx.store.put("receipts", l.key, l satisfies ReceiptLine);
    added++;
  }
  ctx.log(`receive: ${added} new lines`);
  return { added };
}

/** Hourly: record the serial or batch numbers on received lines, and the stock on hand for each one. */
export async function batchTrace(ctx: Ctx<Settings>) {
  const receipts = Object.values(await ctx.store.list<ReceiptLine>("receipts"));
  if (!receipts.length) return { serials: 0, stock: 0 };
  let serials = 0, stock = 0;
  for (const s of await serialRecords(ctx, new Set(receipts.map((r) => r.line_id)))) {
    if (await ctx.store.get("serials", s.key)) continue;
    await ctx.store.put("serials", s.key, s);
    serials++;
  }
  for (const r of receipts.filter((x) => x.barcode).slice(0, 50)) {
    try {
      const unit = (await stockFor(ctx, r.barcode!))[0];
      if (!unit) continue;
      await ctx.store.put("stock", r.key, snapshot(ctx, r, unit) satisfies StockSnapshot);
      stock++;
    } catch (e: any) {
      ctx.log(`batch-trace: stock for a received line not read: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  ctx.log(`batch-trace: ${serials} serials, ${stock} stock snapshots`);
  return { serials, stock };
}

/** Every 15 minutes: queue each proposed stock adjustment for approval, and note the ones a person has approved. */
export async function adjust(ctx: Ctx<Settings>) {
  let queued = 0, rejected = 0, applied = 0;
  for (const p of Object.values(await ctx.store.list<Proposal>("proposals"))) {
    if (p.status === "queued" && p.queued_approval) {
      const ap = await ctx.store.get<Approval>("approvals", p.queued_approval);
      if (ap?.status === "done") { p.status = "adjusted"; p.ref = ap.results?.[0]?.ref ?? {}; applied++; await ctx.store.put("proposals", p.key, p); }
      else if (ap?.status === "rejected" || ap?.status === "failed") { p.status = "rejected"; p.reject_reason = `approval ${ap.status}`; rejected++; await ctx.store.put("proposals", p.key, p); }
      continue;
    }
    if (p.status !== "proposed") continue;
    // Without a branch an adjustment could land on any branch's stock. Hold the proposal until the branch is set.
    if (!ctx.settings.cin7?.branch_id) { ctx.log(`adjust: ${p.key} held: set cin7.branch_id in settings first`); continue; }
    try {
      const q = Number(p.qty_adjusted);
      if (!Number.isFinite(q) || q === 0 || Math.abs(q) > 100000) throw new Error("quantity must be a non-zero number up to 100000");
      const unit = (await stockFor(ctx, p.barcode))[0];
      if (!unit) throw new Error("no stock unit for this barcode in the branch");
      p.queued_approval = await queueAdjustment(ctx, p, unit);
      p.status = "queued";
      queued++;
    } catch (e: any) {
      p.status = "rejected";
      p.reject_reason = String(e?.message ?? e).slice(0, 200);
      rejected++;
    }
    await ctx.store.put("proposals", p.key, p);
  }
  ctx.log(`adjust: ${queued} queued, ${rejected} rejected, ${applied} applied`);
  return { queued, rejected, applied };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { receive, "batch-trace": batchTrace, adjust };
