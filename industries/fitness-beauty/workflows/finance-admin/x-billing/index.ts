// The failed-payments workflow's three crons. Each reads, notes or queues; none sends, charges or changes a member's account.
// A person approves every retry and every email in the CRM shell.
import type { Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Adapter, Failure, Platform, Settings } from "./types.ts";
import { DAY, money } from "./types.ts";
import { stripe } from "./adapters/stripe.ts";
import { xero } from "./adapters/xero.ts";

export const ADAPTERS: Record<Platform, Adapter> = { stripe, xero };
const adapter = (p: Platform): Adapter => {
  const a = ADAPTERS[p];
  if (!a) throw new Error(`x-billing: unknown source ${p}`);
  return a;
};
const DAYS = (s: Settings) => s.chase_after_days ?? [1, 5, 10];

/** Hourly: find failed Stripe charges and overdue Xero invoices, and note each new one in Xero. Reads and notes only. */
export async function detect(ctx: Ctx<Settings>) {
  let added = 0;
  for (const p of ctx.settings.sources) {
    const a = adapter(p);
    for (const found of await a.overdue(ctx)) {
      const known = await ctx.store.get<Failure>("failures", found.key);
      // A part payment changes the amount of an open failure: keep the amount the next chase step uses in line with the platform.
      if (known) {
        if (known.status === "open" && known.amount_due !== found.amount_due) await ctx.store.put("failures", found.key, { ...known, amount_due: found.amount_due });
        continue;
      }
      const f: Failure = { ...found, first_seen: ctx.now.toISOString(), chases: [], status: "open" };
      const label = f.number ?? f.invoice;
      if (a.note) await a.note(ctx, f, "seen", `Payment of ${money(f.amount_due, f.currency)} is past due or failed (found ${f.first_seen.slice(0, 10)}). Chase steps wait for approval.`);
      await ctx.store.put("failures", f.key, f);
      ctx.log(`failure found: ${p} ${label}`);
      added++;
    }
  }
  return { added };
}

/** Daily, before the chase: close failures that have since been paid, and note that in Xero. Reads and notes only. */
export async function reconcile(ctx: Ctx<Settings>) {
  let closed = 0;
  for (const f of Object.values(await ctx.store.list<Failure>("failures"))) {
    if (f.status !== "open") continue;
    const a = adapter(f.platform);
    if (!(await a.isPaid(ctx, f))) continue;
    if (a.note) await a.note(ctx, f, "resolved", `Payment received, failure closed (${ctx.now.toISOString().slice(0, 10)}).`);
    await ctx.store.put("failures", f.key, { ...f, status: "resolved", resolved: ctx.now.toISOString() } satisfies Failure);
    closed++;
  }
  return { closed };
}

/** Whether an approval was closed by its check: the record changed after it was queued, so nothing was sent for it. */
async function closedByCheck(ctx: Ctx<Settings>, id: string): Promise<boolean> {
  const ap = await ctx.store.get<Approval>("approvals", id);
  return ap?.status === "rejected" && ap.decided_by === "check";
}

/** Daily, after reconcile: queue the next chase step on each open failure that is due. Queues only; a person approves each one. */
export async function chase(ctx: Ctx<Settings>) {
  const days = DAYS(ctx.settings);
  let queued = 0, skipped = 0;
  for (const seen of Object.values(await ctx.store.list<Failure>("failures"))) {
    if (seen.status !== "open") continue;
    let f = seen;
    // A step its check closed was never sent: take it back, so it is queued again on the invoice as it is now.
    if (f.last_approval && (await closedByCheck(ctx, f.last_approval))) f = { ...f, chases: f.chases.slice(0, -1), last_approval: undefined };
    const n = f.chases.length;
    if (n < days.length && ctx.now.getTime() - Date.parse(f.first_seen) >= days[n] * DAY) {
      const id = await adapter(f.platform).chase(ctx, f, n + 1);
      if (!id) { skipped++; ctx.log(`chase ${f.key}: no email on file, needs a person`); }
      else if (await closedByCheck(ctx, id)) { skipped++; ctx.log(`chase ${f.key}: the invoice changed since this step was queued; waiting for the invoice to be read again`); }
      else { f = { ...f, chases: [...f.chases, ctx.now.toISOString()], last_approval: id }; queued++; }
    }
    if (f !== seen) await ctx.store.put("failures", f.key, f);
  }
  return { queued, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { detect, reconcile, chase };
