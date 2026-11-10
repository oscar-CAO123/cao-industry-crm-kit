// Xero: the grower's supplier bill and the payment that settles it. Reading a bill is a draft operation;
// paying is a live operation, so it is only ever queued for a person to approve.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Packout, ACCOUNT, day, guid } from "../types.ts";

export interface Bill { id: string; number?: string; status: string; type: string; amountDue: number }

/** Read one bill by id. Nothing leaves the business. */
export async function readBill(ctx: Ctx<Settings>, invoiceId: string): Promise<Bill | undefined> {
  const r = await ctx.draft<any>({ platform: "xero", op: "accounting.getInvoice", summary: "grower bill",
    input: { params: { InvoiceID: guid(invoiceId) } } });
  const inv = r.data?.Invoices?.[0];
  if (!inv) return undefined;
  return {
    id: guid(inv.InvoiceID),
    number: typeof inv.InvoiceNumber === "string" ? inv.InvoiceNumber.slice(0, 60) : undefined,
    status: String(inv.Status ?? ""),
    type: String(inv.Type ?? ""),
    amountDue: Number(inv.AmountDue),
  };
}

/** Queue the grower payment against the bill. It runs only when a person approves it. */
export function queuePayment(ctx: Ctx<Settings>, p: Packout, net: number): Promise<string> {
  if (!ACCOUNT.test(String(ctx.settings.bank_account_code))) throw new Error("packout: bank_account_code is not a Xero account code");
  return ctx.queue({
    platform: "xero",
    op: "accounting.createPayment",
    key: `pay:${p.key}`,
    summary: `pay ${p.grower} $${net.toFixed(2)} against bill ${guid(p.bill_invoice_id).slice(0, 8)}`,
    input: { body: {
      Invoice: { InvoiceID: guid(p.bill_invoice_id) },
      Account: { Code: ctx.settings.bank_account_code },
      Date: day(ctx.now),
      Amount: net,
      Reference: `Grower ${String(p.period_end)}`.slice(0, 255),
    } },
  });
}
