// The bills workflow's two crons. Each reads and drafts: a bill enters Xero as a DRAFT, and its authorisation is only
// ever queued for a person to approve. Judgment (reading a document, choosing the account code for each line) belongs
// to the agent skill in SKILL.md, which writes the bill into the bills store as status "new".
import type { Ctx, Act } from "../../../../../core/workflows/runtime.ts";
import { WriteBlocked } from "../../../../../core/lib/http.ts";
import { type Bill, type Settings, DAY, money, total, validate } from "./types.ts";
import * as xero from "./adapters/xero.ts";

async function park(ctx: Ctx<Settings>, key: string, b: Bill, status: "needs-coding" | "needs-review", reason: string) {
  await ctx.store.put("bills", key, { ...b, status, reason });
}

/** Queue the authorisation of an entered bill once. A cron that runs again finds the approval and queues nothing new. */
async function queueAuthorise(ctx: Ctx<Settings>, key: string, b: Bill) {
  const act: Act = xero.authoriseAct(key, b, b.ref!.invoice_id);
  await ctx.queue(act);
}

/** Every 15 minutes: enter each new bill as a DRAFT in Xero, after its checks, then queue its authorisation for approval. */
export async function enter(ctx: Ctx<Settings>) {
  let codes: Set<string> | undefined; // read from Xero only once a bill needs checking
  const counts = { entered: 0, queued: 0, parked: 0, duplicate: 0 };
  for (const [key, b] of Object.entries(await ctx.store.list<Bill>("bills"))) {
    if (b.status === "entered" && b.ref?.invoice_id) { await queueAuthorise(ctx, key, b); counts.queued++; continue; }
    if (b.status !== "new") continue;
    const bad = validate(b);
    if (bad) { await park(ctx, key, b, "needs-review", bad); counts.parked++; continue; }
    codes ??= await xero.chartCodes(ctx);
    const unknown = [...new Set(b.lines.map((l) => l.account_code).filter((c) => !codes!.has(c)))];
    if (unknown.length) { await park(ctx, key, b, "needs-coding", `account code not in the Xero chart: ${unknown.join(", ")}`); counts.parked++; continue; }
    try {
      const contact = await xero.supplierId(ctx, b, key);
      const dup = await xero.existingBill(ctx, b.invoice_number, contact);
      if (dup) {
        await ctx.store.put("bills", key, { ...b, status: "duplicate", reason: "a bill with this number from this supplier is already in Xero", ref: { ...b.ref, contact_id: contact, invoice_id: dup } });
        counts.duplicate++; continue;
      }
      if (b.po_number) {
        const po = await xero.purchaseOrder(ctx, b.po_number);
        if (!po) { await park(ctx, key, b, "needs-review", `purchase order ${b.po_number} is not in Xero`); counts.parked++; continue; }
        const t = total(b.lines);
        if (Math.abs(po.subtotal - t) > 0.005) {
          await park(ctx, key, b, "needs-review", `purchase order ${b.po_number} is ${money(po.subtotal)} ex GST and the bill is ${money(t)} ex GST`);
          counts.parked++; continue;
        }
      }
      const invoiceId = await xero.enterBill(ctx, key, b, contact);
      const entered: Bill = { ...b, status: "entered", reason: undefined, ref: { ...b.ref, contact_id: contact, invoice_id: invoiceId } };
      await ctx.store.put("bills", key, entered);
      await queueAuthorise(ctx, key, entered);
      counts.entered++;
    } catch (e: any) {
      if (e instanceof WriteBlocked) throw e; // the deploy does not allow writes: stop, do not park the bill
      // A retry is safe: the supplier, bill and authorisation keys are idempotent, and the duplicate check runs first.
      await park(ctx, key, b, "needs-review", `Xero did not take this bill: ${String(e?.message ?? e).slice(0, 160)}`);
      counts.parked++;
    }
  }
  ctx.log(`enter: ${counts.entered} entered, ${counts.queued} authorisations queued, ${counts.parked} parked, ${counts.duplicate} duplicates`);
  return counts;
}

/** Daily: list the authorised supplier bills that are past due, for the owner or the accountant. Read and store only. */
export async function review(ctx: Ctx<Settings>) {
  const cutoff = ctx.now.getTime() - (ctx.settings.overdue_grace_days ?? 0) * DAY;
  const all = await xero.authorisedBills(ctx);
  const overdue = all.filter((b) => b.owing > 0 && b.due && Date.parse(b.due + "T00:00:00Z") < cutoff);
  const owing = Math.round(overdue.reduce((a, b) => a + b.owing, 0) * 100) / 100;
  await ctx.store.put("overdue", "latest", { at: ctx.now.toISOString(), count: overdue.length, owing_total: owing, bills: overdue });
  ctx.log(`review: ${overdue.length} overdue, ${money(owing)} owing`);
  return { overdue: overdue.length, owing };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { enter, review };
