// The transport invoices workflow's three crons. Each reads and drafts, or queues an approval. None authorises, emails or reminds.
// A trip without proof of delivery, or with a code that is not on the rate card, waits with a reason; a person settles it.
import type { Act, Ctx } from "../../../../../core/workflows/runtime.ts";
import * as xero from "./adapters/xero.ts";
import { type Settings, type Trip, daysBetween, day, money, round2 } from "./types.ts";

/** Queues the authorise and email for one drafted invoice. Re-running finds the same approval. */
async function queueSend(ctx: Ctx<Settings>, t: Trip): Promise<void> {
  const id = t.invoice_id!;
  const key = `invoice:${t.id}`;
  const amount = money(t.total_ex_gst ?? 0);
  if (!t.customer.email) {
    await ctx.queue(xero.authoriseAct(id, key), `Authorise invoice for ${t.reference} (${amount} ex GST): no email on file, send it from Xero`);
    return;
  }
  await ctx.queue([
    xero.authoriseAct(id, key),
    xero.emailAct(id, `email:${id}`, `email invoice ${id} to ${t.customer.email}`),
  ], `Authorise and email invoice for ${t.reference} (${amount} ex GST) to ${t.customer.email}`);
}

/** Every 30 minutes: a trip with proof of delivery becomes a DRAFT invoice priced from the rate card, and its send is queued. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Trip>("trips")).filter((t) => t.status === "new" || t.status === "needs-check");
  if (!todo.length) return { drafted: 0, parked: 0 };
  const rates = await xero.rateCard(ctx);
  let drafted = 0, parked = 0;
  for (const t of todo) {
    const park = async (reason: string) => { parked++; await ctx.store.put("trips", t.id, { ...t, status: "needs-check", reason } satisfies Trip); };
    if (!t.pod) { await park("no proof of delivery on file yet: the invoice waits for the signed docket"); continue; }
    if (!Array.isArray(t.lines) || !t.lines.length) { await park("no items recorded on the trip"); continue; }
    const priced: { item: { code: string; name: string; price: number }; qty: number }[] = [], bad: string[] = [];
    for (const l of t.lines) {
      const item = rates.get(String(l.code).toLowerCase()), qty = Number(l.qty);
      if (!item || !(qty > 0) || qty > 100000) { bad.push(String(l.code)); continue; }
      priced.push({ item, qty });
    }
    if (bad.length) { await park(`not on the rate card or bad quantity: ${bad.slice(0, 5).join(", ")}`); continue; }
    const contact = await xero.contactId(ctx, t.customer, t.id);
    const invoice = await xero.draftInvoice(ctx, t, priced, contact);
    const total = round2(priced.reduce((a, p) => a + p.qty * p.item.price, 0));
    const rec: Trip = { ...t, status: "drafted", reason: undefined, contact_id: contact, invoice_id: invoice, total_ex_gst: total, amount_due: total, chased: t.chased ?? [] };
    await ctx.store.put("trips", t.id, rec);
    await queueSend(ctx, rec);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${parked} parked`);
  return { drafted, parked };
}

/** Hourly: reads each drafted or sent invoice's status and amount due in Xero, so the trip records match the accounts. Reads only. */
export async function reconcile(ctx: Ctx<Settings>) {
  const open = Object.values(await ctx.store.list<Trip>("trips"))
    .filter((t) => t.invoice_id && (t.status === "drafted" || t.status === "authorised"));
  const seen = await xero.refresh(ctx, open.map((t) => t.invoice_id!));
  let updated = 0;
  for (const t of open) {
    const s = seen.get(t.invoice_id!);
    if (!s) continue;
    await ctx.store.put("trips", t.id, { ...t, status: s.status, amount_due: s.amount_due, due: s.due, sent: s.sent } satisfies Trip);
    updated++;
  }
  ctx.log(`reconcile: ${updated} read`);
  return { updated };
}

/** Daily: an authorised, sent invoice that is past due gets its next reminder queued. Nothing is emailed by the cron itself. */
export async function chase(ctx: Ctx<Settings>) {
  const steps = ctx.settings.chase_after_days_past_due ?? [7, 21];
  const today = day(ctx.now);
  let queued = 0;
  for (const t of Object.values(await ctx.store.list<Trip>("trips"))) {
    if (t.status !== "authorised" || !t.sent || !(t.amount_due ?? 0) || !t.due || !t.invoice_id) continue;
    const chased = t.chased ?? [];
    const n = chased.length;
    if (n >= steps.length) continue;
    const pastDue = Math.floor(daysBetween(t.due, today));
    if (pastDue < steps[n]) continue;
    await ctx.queue(xero.emailAct(t.invoice_id, `chase:${t.invoice_id}:${n + 1}`, `reminder ${n + 1} for invoice ${t.reference}`),
      `Reminder ${n + 1} for invoice ${t.reference}: ${money(t.amount_due)} due, ${pastDue} days past due`);
    await ctx.store.put("trips", t.id, { ...t, chased: [...chased, ctx.now.toISOString()] } satisfies Trip);
    queued++;
  }
  ctx.log(`chase: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { draft, reconcile, chase };
