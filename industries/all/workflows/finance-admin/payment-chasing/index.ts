// The payment-chasing workflow's three crons. Each reads and drafts. None of them sends.
// A reminder is drafted in Outlook and queued as one approval: send the draft, then note the reminder on the invoice in Xero.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { openInvoices, contactOf, invoicePdfBase64, historyAct } from "./adapters/xero.ts";
import { mailDraft, sendAct } from "./adapters/microsoft-365.ts";
import { type Settings, type InvoiceRow, type Chase, type StageRec, type Contact, GUID, money, day, daysOverdue, stageFor, paused, reminderText, digestHtml, keyOf } from "./types.ts";

/** The ladder in day order, checked once: a bad setting stops the crons rather than chasing the wrong people. */
function ladderOf(s: Settings) {
  const l = [...(s.ladder ?? [])].sort((a, b) => a.days_overdue - b.days_overdue);
  if (!l.length) throw new Error("payment-chasing: settings.ladder is empty");
  for (const x of l) if (!Number.isInteger(x.days_overdue) || x.days_overdue < 1 || !["friendly", "firm", "final"].includes(x.tone)) throw new Error("payment-chasing: bad ladder step");
  return l;
}

/** Hourly: read the authorised invoices from Xero, keep what is owing, and mark any invoice that has dropped off the list as closed (paid, voided or deleted). */
export async function refresh(ctx: Ctx<Settings>) {
  const { rows, ids } = await openInvoices(ctx);
  const seen = ctx.now.toISOString();
  for (const r of rows) await ctx.store.put("invoices", r.id, { ...r, days_overdue: daysOverdue(r.due, ctx.now), seen } satisfies InvoiceRow);
  let closed = 0;
  for (const [id, row] of Object.entries(await ctx.store.list<InvoiceRow>("invoices"))) {
    if (row.closed || ids.has(id)) continue;
    await ctx.store.put("invoices", id, { ...row, closed: seen } satisfies InvoiceRow);
    closed++;
  }
  ctx.log(`refresh: ${rows.length} open, ${closed} closed since the last check`);
  return { open: rows.length, closed };
}

/** Make sure a reminder for this stage exists as an Outlook draft. A draft already made is reused, so a re-run never makes a second one. */
async function draftStage(ctx: Ctx<Settings>, r: InvoiceRow, days: number, contact: Contact, rec: StageRec | undefined, tone: string): Promise<StageRec> {
  if (rec?.message_id && rec.to) return rec;
  const text = reminderText(tone as "friendly" | "firm" | "final", r, contact.first, days, ctx.settings.business_name ?? "");
  const pdf = await invoicePdfBase64(ctx, r.id);
  const name = `invoice-${r.number.replace(/[^A-Za-z0-9_-]/g, "") || r.id.slice(0, 8)}.pdf`;
  const message_id = await mailDraft(ctx, { to: contact.email!, subject: text.subject, html: text.html, attachment: { name, bytes: pdf } });
  return { drafted: ctx.now.toISOString(), to: contact.email, message_id };
}

/** Daily: for each invoice past a ladder step, draft that step's reminder once and queue its send for approval. */
export async function draft(ctx: Ctx<Settings>) {
  const s = ctx.settings, ladder = ladderOf(s);
  const rows = Object.values(await ctx.store.list<InvoiceRow>("invoices")).filter((r) => !r.closed && r.due && r.amount_due > 0);
  const contacts = new Map<string, Contact>();
  let queued = 0, skipped = 0, errors = 0;
  for (const r of rows) {
    try {
      const days = daysOverdue(r.due, ctx.now);
      const stage = stageFor(ladder, days);
      if (!stage || paused(s, r) || r.amount_due < (s.min_amount ?? 0) || !GUID.test(r.contact_id)) { skipped++; continue; }
      const chase = (await ctx.store.get<Chase>("chases", r.id)) ?? { invoice_id: r.id, stages: {} };
      if (Object.keys(chase.stages).some((k) => Number(k) >= stage)) continue;   // this step or a later one is already queued
      let contact = contacts.get(r.contact_id);
      if (!contact) { contact = await contactOf(ctx, r.contact_id); contacts.set(r.contact_id, contact); }
      if (!contact.email) { skipped++; continue; }                               // no valid email on the client: a person follows up
      const tone = ladder[stage - 1].tone;
      const rec = await draftStage(ctx, r, days, contact, chase.stages[String(stage)], tone);
      chase.stages[String(stage)] = rec;
      await ctx.store.put("chases", r.id, chase);
      const key = keyOf(`chase:${r.id}:${stage}`);
      const id = await ctx.queue(
        [sendAct(ctx, rec.message_id!, rec.to!, key), historyAct(r.id, stage, rec.to!, key)],
        `Email reminder ${stage} (${tone}) for invoice ${r.number} to ${rec.to}: ${money(r.amount_due)} owing, ${days} days overdue. Check Xero first in case it has just been paid.`);
      chase.stages[String(stage)] = { ...rec, approval: id };
      await ctx.store.put("chases", r.id, chase);
      queued++;
    } catch (e: any) {
      errors++;
      ctx.log(`draft: invoice ${r.number} left for the next run: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  ctx.log(`draft: ${queued} queued for approval, ${skipped} skipped, ${errors} errors`);
  return { queued, skipped, errors };
}

/** Weekdays: one digest draft to the owner, listing what is overdue and which invoices need a person. Once per day. */
export async function summary(ctx: Ctx<Settings>) {
  const s = ctx.settings, ladder = ladderOf(s), today = day(ctx.now);
  if (await ctx.store.get("digests", today)) return { drafted: 0 };
  const chases = await ctx.store.list<Chase>("chases");
  const rows = Object.values(await ctx.store.list<InvoiceRow>("invoices"))
    .filter((r) => !r.closed && r.due && daysOverdue(r.due, ctx.now) > 0)
    .sort((a, b) => daysOverdue(b.due, ctx.now) - daysOverdue(a.due, ctx.now));
  const view = rows.map((r) => {
    const days = daysOverdue(r.due, ctx.now);
    const sent = Object.keys(chases[r.id]?.stages ?? {}).map(Number);
    const last = sent.length ? `${ladder[Math.max(...sent) - 1]?.tone ?? "reminder"} (queued or sent)` : "none yet";
    return { r, last, needsPerson: stageFor(ladder, days) >= ladder.length, paused: paused(s, r) };
  });
  const total = Math.round(rows.reduce((a, r) => a + r.amount_due, 0) * 100) / 100;
  const id = await mailDraft(ctx, { to: s.owner_email ?? s.mailbox, subject: `Overdue invoices on ${today}: ${rows.length}`, html: digestHtml(view, total) });
  await ctx.store.put("digests", today, { drafted: ctx.now.toISOString(), message_id: id });
  ctx.log(`summary: digest drafted for ${rows.length} overdue invoices`);
  return { drafted: 1, overdue: rows.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { refresh, draft, summary };
