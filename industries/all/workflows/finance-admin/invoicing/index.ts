// The invoicing workflow's three crons. Each reads and drafts, or queues an approval. None authorises, emails or pays.
// Judgment (pricing a job with no materials, a disputed amount, a customer who pays in another way) stays with the
// person who runs the business; a parked record says why.
import type { Act, Ctx } from "../../../../../core/workflows/runtime.ts";
import * as s8 from "./adapters/servicem8.ts";
import * as xero from "./adapters/xero.ts";
import { type InvoiceRecord, type PaymentRecord, type Settings, daysBetween, day, money, round2 } from "./types.ts";

/** Queues the authorise and email (and the ServiceM8 mark) for one drafted invoice. Re-running finds the same approval. */
async function queueSend(ctx: Ctx<Settings>, rec: InvoiceRecord): Promise<void> {
  const id = rec.invoice_id!;
  const key = `invoice:${rec.job}`;
  const amount = money(rec.total_ex_gst ?? 0);
  if (!rec.email) {
    await ctx.queue(xero.authoriseAct(id, key), `Authorise invoice ${id} (${amount} ex GST): no email on file, send it from Xero`);
    return;
  }
  const acts: Act[] = [
    xero.authoriseAct(id, key),
    xero.emailAct(id, `email:${id}`, `email invoice ${id} to ${rec.email}`),
  ];
  if (ctx.settings.mark_invoice_sent) acts.push(s8.markInvoicedAct(rec.job));
  await ctx.queue(acts, `Authorise and email invoice ${id} (${amount} ex GST) to ${rec.email}${ctx.settings.mark_invoice_sent ? ", then mark the ServiceM8 job invoiced" : ""}`);
}

/** Reads each open invoice in Xero and writes its status back to the store. Returns the invoices still open. */
async function syncOpen(ctx: Ctx<Settings>): Promise<InvoiceRecord[]> {
  const open = Object.values(await ctx.store.list<InvoiceRecord>("invoices"))
    .filter((r) => r.invoice_id && (r.status === "drafted" || r.status === "authorised"));
  const seen = await xero.refresh(ctx, open.map((r) => r.invoice_id!));
  for (const r of open) {
    const s = seen.get(r.invoice_id!);
    if (!s) continue;
    Object.assign(r, { status: s.status, amount_due: s.amount_due, due: s.due, sent: s.sent });
    await ctx.store.put("invoices", r.job, r);
  }
  return open.filter((r) => r.status === "drafted" || r.status === "authorised");
}

/** Every 30 minutes: a completed job becomes a DRAFT invoice in Xero, and its send is queued for approval. */
export async function draft(ctx: Ctx<Settings>) {
  let drafted = 0, parked = 0;
  for (const j of await s8.completedJobs(ctx)) {
    const have = await ctx.store.get<InvoiceRecord>("invoices", j.uuid);
    if (have?.status === "drafted") { await queueSend(ctx, have); continue; } // queue is idempotent: never a second approval
    if (have && have.status !== "needs-lines") continue;
    const { lines, bad } = await s8.jobLines(ctx, j.uuid);
    if (!lines.length || bad) {
      const reason = bad ? "a material line has no usable quantity or price" : "no materials on the job yet: price it, the next run drafts it";
      await ctx.store.put("invoices", j.uuid, { job: j.uuid, status: "needs-lines", reason, chased: [], created: ctx.now.toISOString() } satisfies InvoiceRecord);
      parked++;
      continue;
    }
    const contact = await s8.contactFor(ctx, j.company_uuid);
    const contactId = await xero.contactId(ctx, contact, j.uuid);
    const invoiceId = await xero.draftInvoice(ctx, j.uuid, lines, contactId);
    const rec: InvoiceRecord = {
      job: j.uuid, status: "drafted", invoice_id: invoiceId, contact_id: contactId, email: contact.email,
      total_ex_gst: round2(lines.reduce((a, l) => a + l.qty * l.unitPrice, 0)), chased: [], created: ctx.now.toISOString(),
    };
    rec.amount_due = rec.total_ex_gst;
    await ctx.store.put("invoices", j.uuid, rec);
    await queueSend(ctx, rec);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${parked} parked`);
  return { drafted, parked };
}

/** Hourly: a payment the trade took in ServiceM8 is queued against its Xero invoice. Nothing is recorded directly. */
export async function payments(ctx: Ctx<Settings>) {
  let queued = 0, parked = 0;
  for (const r of await syncOpen(ctx)) {
    if (r.status !== "authorised" || !(r.amount_due ?? 0)) continue;
    for (const p of await s8.paymentsFor(ctx, r.job)) {
      if (await ctx.store.get<PaymentRecord>("payments", p.uuid)) continue;
      const amount = round2(Number(p.amount));
      let rec: PaymentRecord = { job: r.job, invoice: r.invoice_id, amount, status: "queued" };
      if (!(amount > 0)) rec = { ...rec, status: "skipped", reason: "zero amount" };
      else if (amount > (r.amount_due ?? 0)) rec = { ...rec, status: "parked", reason: "more than the amount due: check it in ServiceM8 and Xero" };
      else if (!ctx.settings.bank_account_code) rec = { ...rec, status: "parked", reason: "set bank_account_code in settings" };
      else {
        await ctx.queue(xero.paymentAct(ctx, r.invoice_id!, amount, p.uuid), `Record ${money(amount)} against invoice ${r.invoice_id} in Xero`);
        r.amount_due = round2((r.amount_due ?? 0) - amount);
        queued++;
      }
      if (rec.status === "parked") parked++;
      await ctx.store.put("payments", p.uuid, rec);
    }
  }
  ctx.log(`payments: ${queued} queued, ${parked} parked`);
  return { queued, parked };
}

/** Daily: an authorised, sent invoice that is past due gets its next reminder queued. A reminder is the invoice email. */
export async function chase(ctx: Ctx<Settings>) {
  const steps = ctx.settings.chase_after_days_past_due ?? [7, 21];
  const today = day(ctx.now);
  let queued = 0;
  for (const r of await syncOpen(ctx)) {
    if (r.status !== "authorised" || !r.sent || !(r.amount_due ?? 0) || !r.due) continue;
    const n = r.chased.length;
    if (n >= steps.length) continue;
    const pastDue = Math.floor(daysBetween(r.due, today));
    if (pastDue < steps[n]) continue;
    await ctx.queue(xero.emailAct(r.invoice_id!, `chase:${r.invoice_id}:${n + 1}`, `reminder ${n + 1} for invoice ${r.invoice_id}`),
      `Reminder ${n + 1} for invoice ${r.invoice_id}: ${money(r.amount_due)} due, ${pastDue} days past due`);
    r.chased = [...r.chased, ctx.now.toISOString()];
    await ctx.store.put("invoices", r.job, r);
    queued++;
  }
  ctx.log(`chase: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { draft, payments, chase };
