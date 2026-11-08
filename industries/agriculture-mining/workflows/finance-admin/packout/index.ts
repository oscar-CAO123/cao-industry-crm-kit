// The grower statements workflow's two crons. Each reads or drafts or queues; none pays. A person approves every payment.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { readBill, queuePayment } from "./adapters/xero.ts";
import { type Settings, type Packout, type Statement, problem, netOf } from "./types.ts";

/** Every 30 minutes: check each new pack-out against its Xero bill, draft the statement, queue the payment for approval. */
export async function statement(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Packout>("packouts")).filter((p) => p.status === "new");
  let queued = 0, held = 0;
  for (const p of todo) {
    const hold = async (reason: string) => { held++; await ctx.store.put("packouts", p.key, { ...p, status: "held", reason }); };
    const why = problem(p);
    if (why) { await hold(why); continue; }
    const net = netOf(p);
    const bill = await readBill(ctx, p.bill_invoice_id);
    if (!bill) { await hold("Xero has no bill with that id"); continue; }
    if (bill.type !== "ACCPAY") { await hold("the bill is not a supplier bill"); continue; }
    if (bill.status !== "AUTHORISED") { await hold(`the bill is ${bill.status}, not AUTHORISED`); continue; }
    if (!(bill.amountDue >= net)) { await hold(`Xero shows ${bill.amountDue} owed, less than the net ${net}`); continue; }
    const drafted: Statement = {
      key: p.key, grower: p.grower, period_end: p.period_end, gross: p.gross, charges: p.charges,
      net, xero_amount_due: bill.amountDue, drafted: ctx.now.toISOString(),
    };
    const approval = await queuePayment(ctx, p, net); // same key on a re-run, so it is never queued twice
    await ctx.store.put("packouts", p.key, { ...p, status: "queued", statement: drafted, approval, reason: undefined });
    queued++;
  }
  ctx.log(`statement: ${queued} queued, ${held} held`);
  return { queued, held };
}

/** Hourly: a queued pack-out whose payment was approved and whose bill Xero now shows paid is marked paid. Reads only. */
export async function reconcile(ctx: Ctx<Settings>) {
  const queued = Object.values(await ctx.store.list<Packout>("packouts")).filter((p) => p.status === "queued");
  let paid = 0;
  for (const p of queued) {
    const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `pay:${p.key}`));
    if (!ap) continue;
    if (ap.status === "rejected") { await ctx.store.put("packouts", p.key, { ...p, status: "held", reason: "payment rejected" }); continue; }
    if (ap.status !== "done") continue; // pending, running, failed or needs-check: a person looks at those
    const bill = await readBill(ctx, p.bill_invoice_id);
    if (bill && (bill.status === "PAID" || bill.amountDue === 0)) {
      await ctx.store.put("packouts", p.key, { ...p, status: "paid" });
      paid++;
    }
  }
  ctx.log(`reconcile: ${paid} paid`);
  return { paid };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { statement, reconcile };
