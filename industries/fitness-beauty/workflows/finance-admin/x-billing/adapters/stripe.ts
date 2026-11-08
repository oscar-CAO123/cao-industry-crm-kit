// Stripe: the failed charge on an invoice. An invoice counts as failed when Stripe has attempted it and money is still owed.
// Retry and invoice email move money or reach the member, so they are live operations: a cron only queues them.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, STRIPE_INVOICE, emailOf, textOf, dueDay, keyOf, money } from "../types.ts";

const P = "stripe";
const sid = (v: unknown) => { const s = String(v ?? ""); if (!STRIPE_INVOICE.test(s)) throw new Error("stripe: bad invoice id"); return s; };

export const stripe: Adapter = {
  id: P,
  async overdue(ctx: Ctx<Settings>) {
    const r = await ctx.draft<any>({ platform: P, op: "openapi_spec3.GetInvoices", summary: "open invoices", input: { params: { status: "open", limit: 100 } } });
    return (r.data?.data ?? []).flatMap((i: any) => {
      const remaining = Number(i.amount_remaining);
      if (!STRIPE_INVOICE.test(String(i.id ?? "")) || i.attempted !== true || !Number.isInteger(remaining) || remaining <= 0) return [];
      return [{
        key: keyOf(P, i.id), platform: P, invoice: i.id, number: textOf(i.number, 40),
        contact: { name: textOf(i.customer_name), email: emailOf(i.customer_email) },
        amount_due: remaining / 100, currency: String(i.currency ?? "aud").toUpperCase(),
        due: dueDay(i.due_date ?? undefined), attempts: Number(i.attempt_count) || 0,
      }];
    });
  },
  async isPaid(ctx: Ctx<Settings>, f) {
    const r = await ctx.draft<any>({ platform: P, op: "openapi_spec3.GetInvoicesInvoice", summary: `invoice ${f.number ?? f.invoice}`, input: { params: { invoice: sid(f.invoice) } } });
    return r.data?.status === "paid" || Number(r.data?.amount_remaining) === 0;
  },
  async chase(ctx: Ctx<Settings>, f, n) {
    const id = sid(f.invoice), label = f.number ?? id, who = f.contact.name ?? f.contact.email ?? "the member";
    if (n === 1 && ctx.settings.retry_stripe !== false) {
      return ctx.queue({ platform: P, op: "openapi_spec3.PostInvoicesInvoicePay", key: `chase1:${f.key}`, input: { params: { invoice: id } }, summary: `retry the card on invoice ${label}` },
        `Retry the card on invoice ${label}: ${money(f.amount_due, f.currency)} from ${who}`);
    }
    if (!f.contact.email) return "";
    return ctx.queue({ platform: P, op: "openapi_spec3.PostInvoicesInvoiceSend", key: `chase${n}:${f.key}`, input: { params: { invoice: id } }, summary: `send invoice ${label} for payment` },
      `Send invoice ${label} for payment to ${f.contact.email}: ${money(f.amount_due, f.currency)} (step ${n})`);
  },
};
