// The supplier production workflow's four crons. Each reads, drafts or queues. None authorises, pays or sends.
// Judgment (the lines for an order, which need a factory price or a tech pack) belongs to the agent skill in SKILL.md,
// which writes a proposal into the store; the draft cron checks it against the Xero items list.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Job, Line, Settings } from "./types.ts";
import { money, total, ISO_DAY } from "./types.ts";
import * as monday from "./adapters/monday.ts";
import * as xero from "./adapters/xero.ts";

const DAY = 864e5;

/** Every 30 minutes: new orders on the production board (status New order) become jobs. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const it of await monday.boardItems(ctx)) {
    if (it.status !== ctx.settings.monday.labels.new) continue;
    if (await ctx.store.get("jobs", it.id)) continue;
    await ctx.store.put("jobs", it.id, { id: it.id, name: it.name, factory: it.factory, delivery: ISO_DAY.test(it.delivery) ? it.delivery : undefined,
      received: ctx.now.toISOString(), status: "new" } satisfies Job);
    added++;
  }
  ctx.log(`intake: ${added} new orders`);
  return { added };
}

/** Twice an hour: price each new order from the agent's proposal, draft its purchase order, mark the board, queue the authorisation. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Job>("jobs")).filter((j) => j.status === "new" || j.status === "needs-lines");
  if (!todo.length) return { drafted: 0, needs_lines: 0 };
  const rate = await xero.rateCard(ctx);
  const byCode = new Map(rate.map((r) => [r.code.toLowerCase(), r]));
  let drafted = 0, parked = 0;
  for (const j of todo) {
    const park = async (reason: string) => { parked++; await ctx.store.put("jobs", j.id, { ...j, status: "needs-lines", reason }); };
    const prop = await ctx.store.get<{ lines: { code: string; qty: number; unitPrice?: number }[] }>("proposals", j.id);
    if (!prop?.lines?.length) { await park("no proposal yet: the agent skill sets the lines"); continue; }
    const lines: Line[] = [], bad: string[] = [];
    for (const w of prop.lines) {
      const r = byCode.get(String(w.code).toLowerCase()), qty = Number(w.qty);
      const unit = typeof w.unitPrice === "number" && w.unitPrice >= 0 ? w.unitPrice : r?.price;
      if (!r || !(qty > 0) || qty > 100000 || typeof unit !== "number") { bad.push(String(w.code)); continue; }
      lines.push({ code: r.code, name: r.name, qty, unitCost: unit, ref: r.ref });
    }
    if (bad.length) { await park(`not on the Xero items list or bad quantity: ${bad.slice(0, 5).join(", ")}`); continue; }
    if (!lines.length) { await park("no usable lines"); continue; }
    const contact = await xero.supplierId(ctx, j.factory);
    const po = await xero.draftPurchaseOrder(ctx, j, contact, lines);
    const amount = total(lines);
    await ctx.store.put("jobs", j.id, { ...j, status: "po-drafted", reason: undefined, po: { id: po.id, number: po.number, contact_id: contact, total_ex_gst: amount } } satisfies Job);
    await monday.setStatus(ctx, j.id, ctx.settings.monday.labels.po_drafted);
    await ctx.queue(xero.authorisePoAct(po.id, po.number ?? po.id),
      `Authorise purchase order ${po.number ?? po.id} to ${j.factory} for ${j.name}: ${lines.length} lines, ${money(amount)} ex GST`);
    drafted++;
  }
  ctx.log(`draft: ${drafted} purchase orders drafted, ${parked} need lines`);
  return { drafted, needs_lines: parked };
}

/** Every 4 hours: flag orders whose delivery date is due within the warning window and that have not shipped. */
export async function monitor(ctx: Ctx<Settings>) {
  const warn = (ctx.settings.delivery_warn_days ?? 21) * DAY;
  const items = new Map((await monday.boardItems(ctx)).map((i) => [i.id, i]));
  let flagged = 0;
  for (const j of Object.values(await ctx.store.list<Job>("jobs"))) {
    if (j.status === "shipped") continue;
    const it = items.get(j.id);
    if (!it) continue;
    if (it.status === ctx.settings.monday.labels.shipped) { await ctx.store.put("jobs", j.id, { ...j, status: "shipped" } satisfies Job); continue; }
    const due = j.delivery && ISO_DAY.test(j.delivery) ? Date.parse(j.delivery) : NaN;
    const soon = Number.isFinite(due) && due - ctx.now.getTime() < warn;
    if (soon && j.status !== "at-risk") {
      await monday.setStatus(ctx, j.id, ctx.settings.monday.labels.at_risk);
      await ctx.store.put("jobs", j.id, { ...j, status: "at-risk" } satisfies Job);
      flagged++;
    }
  }
  ctx.log(`monitor: ${flagged} flagged at risk`);
  return { flagged };
}

/** Hourly: for each purchase order Xero shows as authorised, draft the deposit bill and queue it with its payment. */
export async function deposit(ctx: Ctx<Settings>) {
  const pct = ctx.settings.xero?.deposit_percent ?? 0, bank = ctx.settings.xero?.bank_account_code ?? "";
  if (!(pct > 0 && pct < 100) || !bank) return { queued: 0, reason: "set xero.deposit_percent and xero.bank_account_code" };
  let queued = 0;
  for (const j of Object.values(await ctx.store.list<Job>("jobs"))) {
    if (!j.po || j.bill_id) continue;
    const st = await xero.poStatus(ctx, j.po.id);
    if (st !== j.po_status) await ctx.store.put("jobs", j.id, { ...j, po_status: st } satisfies Job);
    if (st !== "AUTHORISED") continue;
    const amount = Math.round(j.po.total_ex_gst * pct) / 100;
    const bill = await xero.draftDepositBill(ctx, j, j.po.contact_id, amount);
    await ctx.store.put("jobs", j.id, { ...j, po_status: st, bill_id: bill } satisfies Job);
    await ctx.queue([xero.authoriseBillAct(bill, j.po.number ?? j.po.id), xero.payDepositAct(bill, amount, j.po.id, bank, ctx.now)],
      `Authorise deposit bill and pay ${money(amount)} (${pct}%) to ${j.factory} for ${j.name}`);
    queued++;
  }
  ctx.log(`deposit: ${queued} queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, monitor, deposit };
