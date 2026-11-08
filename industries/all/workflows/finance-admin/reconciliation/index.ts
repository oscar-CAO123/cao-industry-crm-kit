// The reconciliation workflow's two crons. Each reads and drafts, and queues only a payment against an invoice.
// Judgment (a reference that names no invoice, an amount that differs, a payout with no deposit) goes to the worklist
// for a person. Nothing here sends, pays or changes a status a customer sees; the queued payment waits for approval.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { type BankLine, type Item, type Payout, type Settings, DAY, cents } from "./types.ts";
import * as xero from "./adapters/xero.ts";
import * as stripe from "./adapters/stripe.ts";

const sinceDate = (ctx: Ctx<Settings>, days: number) => new Date(ctx.now.getTime() - days * DAY).toISOString().slice(0, 10);

/** Hourly: read the bank lines on each reconciled account and the processor's payouts. Reads only. */
export async function pull(ctx: Ctx<Settings>) {
  const from = sinceDate(ctx, ctx.settings.lookback_days ?? 60);
  let lines = 0, paid = 0;
  for (const acc of ctx.settings.bank_accounts) {
    for (const l of await xero.bankLines(ctx, acc, from)) {
      await ctx.store.put("bank-lines", safeKey(`${l.account}:${l.id}`), l);
      lines++;
    }
  }
  if (ctx.settings.processor === "stripe") {
    const sinceUnix = Math.floor(Date.parse(from) / 1000);
    for (const p of await stripe.payouts(ctx, sinceUnix)) { await ctx.store.put("payouts", safeKey(p.id), p); paid++; }
  }
  ctx.log(`pull: ${lines} bank lines, ${paid} payouts`);
  return { bank_lines: lines, payouts: paid };
}

/** Once a day: match payouts to their deposits, match receipts to invoices, note matches, queue payments, write the worklist. */
export async function match(ctx: Ctx<Settings>) {
  const lines = Object.values(await ctx.store.list<BankLine>("bank-lines"))
    .filter((l) => !l.reconciled && l.status !== "VOIDED" && l.status !== "DELETED");
  const payouts = Object.values(await ctx.store.list<Payout>("payouts"));
  const windowMs = (ctx.settings.match_window_days ?? 3) * DAY;
  const used = new Set<string>();
  const worklist: Item[] = [];
  let noted = 0, queued = 0;

  // 1. A Stripe payout matches the bank deposit with the same net amount, a few days either side.
  for (const p of payouts) {
    const hit = lines.find((l) => !used.has(l.id) && l.type.startsWith("RECEIVE") && cents(l.amount) === cents(p.amount)
      && Math.abs(Date.parse(l.date) - Date.parse(p.date)) <= windowMs);
    if (!hit) { worklist.push({ kind: "payout", id: p.id, amount: p.amount, date: p.date, reason: "no bank deposit with this amount in the window" }); continue; }
    used.add(hit.id);
    const k = safeKey(`note:${hit.id}`);
    if (!(await ctx.store.get("noted", k))) {
      await xero.note(ctx, hit.id, `Matched to Stripe payout ${p.id}`);
      await ctx.store.put("noted", k, { at: ctx.now.toISOString() });
      noted++;
    }
  }

  // 2. A receipt whose reference names an authorised invoice for the same amount due is queued for approval.
  for (const l of lines) {
    if (used.has(l.id)) continue;
    if (!l.type.startsWith("RECEIVE")) { worklist.push({ kind: "bank", id: l.id, amount: l.amount, date: l.date, reason: "unmatched payment" }); continue; }
    const candidates = (l.reference.match(/[A-Za-z]{1,6}-?\d{2,8}/g) ?? []).slice(0, 3);
    let inv: Awaited<ReturnType<typeof xero.invoiceByNumber>>, number = "";
    for (const c of candidates) { inv = await xero.invoiceByNumber(ctx, c); if (inv) { number = c; break; } }
    if (!inv) { worklist.push({ kind: "bank", id: l.id, amount: l.amount, date: l.date, reason: candidates.length ? "no invoice found for the reference" : "no invoice number in the reference" }); continue; }
    if (inv.status !== "AUTHORISED") { worklist.push({ kind: "bank", id: l.id, amount: l.amount, date: l.date, reason: `invoice ${number} is ${inv.status}` }); continue; }
    if (cents(inv.due) !== cents(l.amount)) { worklist.push({ kind: "bank", id: l.id, amount: l.amount, date: l.date, reason: `amount differs from invoice ${number} amount due` }); continue; }
    used.add(l.id);
    const act = xero.paymentAct(l.account, l.id, inv.id, l.date, l.amount, l.reference || number);
    await ctx.queue(act, act.summary);
    queued++;
  }

  await ctx.store.put("worklist", "latest", { at: ctx.now.toISOString(), items: worklist });
  ctx.log(`match: ${noted} noted, ${queued} queued, ${worklist.length} on the worklist`);
  return { noted, queued, worklist: worklist.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { pull, match };
