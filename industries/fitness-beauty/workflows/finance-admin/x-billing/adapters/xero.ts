// Xero: the overdue invoice. Xero does not know whether a card or direct debit failed, so an authorised invoice past its
// due date stands in for a failed payment. The reminder email is a live operation: a cron only queues it.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, GUID, emailOf, textOf, dueDay, keyOf, money } from "../types.ts";

const P = "xero";
const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad invoice id"); return s; };

export const xero: Adapter = {
  id: P,
  async overdue(ctx: Ctx<Settings>) {
    const today = ctx.now.toISOString().slice(0, 10);
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: "authorised invoices", input: { params: { Statuses: "AUTHORISED" } } });
    return (r.data?.Invoices ?? []).flatMap((i: any) => {
      const owed = Number(i.AmountDue), due = dueDay(i.DueDate);
      if (!GUID.test(String(i.InvoiceID ?? "")) || !(owed > 0) || !due || due >= today) return [];
      return [{
        key: keyOf(P, i.InvoiceID), platform: P, invoice: i.InvoiceID, number: textOf(i.InvoiceNumber, 40),
        contact: { name: textOf(i.Contact?.Name), email: emailOf(i.Contact?.EmailAddress) },
        amount_due: owed, currency: String(i.CurrencyCode ?? "AUD").toUpperCase(), due,
      }];
    });
  },
  async isPaid(ctx: Ctx<Settings>, f) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `invoice ${f.number ?? f.invoice}`, input: { params: { IDs: guid(f.invoice) } } });
    const i = r.data?.Invoices?.[0];
    return i?.Status === "PAID" || i?.Status === "VOIDED" || Number(i?.AmountDue) === 0;
  },
  async note(ctx: Ctx<Settings>, f, tag, text) {
    await ctx.draft<any>({ platform: P, op: "accounting.createInvoiceHistory", summary: `note (${tag}) on ${f.number ?? f.invoice}`,
      input: { params: { InvoiceID: guid(f.invoice), "Idempotency-Key": safeKey(`note:${f.key}:${tag}`, 120) }, body: { HistoryRecords: [{ Details: text.slice(0, 255) }] } } });
  },
  async chase(ctx: Ctx<Settings>, f, n) {
    const id = guid(f.invoice), label = f.number ?? id;
    if (!f.contact.email) return "";
    return ctx.queue({ platform: P, op: "accounting.emailInvoice", key: `chase${n}:${f.key}`, input: { params: { InvoiceID: id } }, summary: `email reminder for invoice ${label}` },
      `Email payment reminder ${n} for invoice ${label} to ${f.contact.email}: ${money(f.amount_due, f.currency)}`);
  },
};
