// The invoice-checking workflow's three crons. Each reads, notes and queues: it never pays, emails or sends.
// Judgment (purchase order matching, supplier queries, unusual amounts) stays with the bookkeeper, see SKILL.md.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Check, type ChaseRecord, type Invoice, type Settings, DAY, day, money, msDate } from "./types.ts";
import { readInvoices, readInvoice, attachmentCount, noteOn, queuePayment, queueReminder, dateTime } from "./adapters/xero.ts";

/** What an invoice needs before a person relies on it. Pure, so the rules can be read and tested without Xero. */
export function assess(inv: Invoice, kind: "bill" | "sales", s: Settings, hasDocument: boolean, dupeOf?: string): string[] {
  const reasons: string[] = [];
  const tol = s.amount_tolerance ?? 1;
  if (!inv.Contact?.Name && !inv.Contact?.ContactID) reasons.push("no supplier or customer on the invoice");
  if (msDate(inv.DueDate) === undefined) reasons.push("no due date");
  if (!(Number(inv.Total) > 0)) reasons.push("total is zero or missing");
  const lines = inv.LineItems ?? [];
  if (!lines.length) reasons.push("no line items");
  lines.forEach((l, i) => { if (kind === "bill" && !l.AccountCode) reasons.push(`line ${i + 1} has no account code`); });
  const sum = Math.round(lines.reduce((a, l) => a + Number(l.LineAmount ?? 0), 0) * 100) / 100;
  if (typeof inv.SubTotal === "number" && Math.abs(sum - inv.SubTotal) > tol) reasons.push(`lines add to ${money(sum)} but the subtotal is ${money(inv.SubTotal)}`);
  if (kind === "bill" && !hasDocument) reasons.push("no source document attached");
  if (dupeOf) reasons.push(`possible duplicate of invoice ${dupeOf}`);
  return reasons;
}

/** Every 30 minutes: check open bills and draft sales invoices, note the result on each, keep it for the other crons. */
export async function check(ctx: Ctx<Settings>) {
  const bills = await readInvoices(ctx, `Type=="ACCPAY"&&(Status=="DRAFT"||Status=="AUTHORISED")`);
  const sales = await readInvoices(ctx, `Type=="ACCREC"&&Status=="DRAFT"`);
  const known: Record<string, Check> = await ctx.store.list<Check>("checks");
  let checked = 0, flagged = 0;
  for (const [kind, inv] of [...bills.map((i) => ["bill", i] as const), ...sales.map((i) => ["sales", i] as const)]) {
    // The attachment count and the account codes are part of the fingerprint, so fixing a bill (coding it, attaching the
    // source document) makes it checked again instead of staying needs-review.
    const documents = kind === "bill" ? await attachmentCount(ctx, inv.InvoiceID) : 0;
    const codes = (inv.LineItems ?? []).map((l) => l.AccountCode ?? "");
    const fingerprint = JSON.stringify([inv.Total ?? "", inv.DueDate ?? "", inv.Status, codes, documents]);
    if (known[inv.InvoiceID]?.fingerprint === fingerprint) continue; // checked, and nothing has changed since
    const supplier = inv.Contact?.Name ?? "";
    const dupeOf = kind === "bill" && supplier && inv.InvoiceNumber
      ? Object.values(known).find((c) => c.kind === "bill" && c.invoice !== inv.InvoiceID && c.supplier === supplier && c.number === inv.InvoiceNumber)?.invoice
      : undefined;
    const hasDocument = kind === "bill" ? documents > 0 : true;
    const reasons = assess(inv, kind, ctx.settings, hasDocument, dupeOf);
    const verdict = reasons.length ? "needs-review" : "passed";
    const rec: Check = { invoice: inv.InvoiceID, kind, supplier, number: inv.InvoiceNumber, verdict, reasons, fingerprint, checked: ctx.now.toISOString() };
    await noteOn(ctx, inv.InvoiceID, fingerprint, `Checked ${day(ctx.now)}: ${reasons.length ? reasons.join("; ") : "no issues found"}`);
    await ctx.store.put("checks", inv.InvoiceID, rec);
    known[inv.InvoiceID] = rec;
    checked++;
    if (reasons.length) flagged++;
  }
  ctx.log(`check: ${checked} checked, ${flagged} need review`);
  return { checked, flagged };
}

/** Hourly: queue a payment for each passed bill that falls due within the set days. A person approves each one. */
export async function payments(ctx: Ctx<Settings>) {
  if (!ctx.settings.bank_account_code) return { queued: 0, reason: "set bank_account_code in settings" };
  const windowMs = (ctx.settings.pay_days_before_due ?? 2) * DAY;
  const passed = Object.values(await ctx.store.list<Check>("checks")).filter((c) => c.kind === "bill" && c.verdict === "passed");
  let queued = 0; // counts bills ready for approval; a bill already queued is not queued again
  for (const c of passed) {
    const inv = await readInvoice(ctx, c.invoice);
    const due = msDate(inv?.DueDate), owed = Number(inv?.AmountDue ?? 0);
    if (!inv || inv.Status !== "AUTHORISED" || !(owed > 0) || due === undefined || due - ctx.now.getTime() > windowMs) continue;
    await queuePayment(ctx, inv, owed);
    queued++;
  }
  ctx.log(`payments: ${queued} ready for approval`);
  return { queued };
}

/** Daily: queue the next reminder for each overdue sales invoice, at most one a day. A person approves each one. */
export async function chase(ctx: Ctx<Settings>) {
  const steps = ctx.settings.chase_after_days ?? [7, 14, 30];
  const today = day(ctx.now);
  const overdue = await readInvoices(ctx, `Type=="ACCREC"&&Status=="AUTHORISED"&&DueDate<${dateTime(ctx.now)}`);
  const records = await ctx.store.list<ChaseRecord>("chases");
  let queued = 0;
  for (const inv of overdue) {
    const due = msDate(inv.DueDate), owed = Number(inv.AmountDue ?? 0);
    if (due === undefined || !(owed > 0)) continue;
    const rec: ChaseRecord = records[inv.InvoiceID] ?? { sent: [] };
    const step = rec.sent.length + 1;
    if (step > steps.length || rec.sent.some((s) => s.on === today)) continue;
    const late = Math.floor((ctx.now.getTime() - due) / DAY);
    if (late < steps[step - 1]) continue;
    const email = inv.Contact?.EmailAddress;
    if (!email) { ctx.log(`chase: no email on the contact for ${inv.InvoiceNumber}`); continue; }
    await queueReminder(ctx, inv, step, `Reminder ${step} for ${inv.InvoiceNumber}: ${money(owed)}, ${late} days overdue, to ${email}`);
    rec.sent.push({ step, on: today });
    await ctx.store.put("chases", inv.InvoiceID, rec);
    queued++;
  }
  ctx.log(`chase: ${queued} queued`);
  return { queued };
}

export const CRONS = { check, payments, chase };
