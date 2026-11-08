// Xero: the bills and sales invoices this workflow checks, the history notes it leaves on them, and the two live
// actions (a bill payment and a reminder email). Reads and notes are drafts; a payment or an email is only ever queued.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Invoice, type Settings, GUID, day, money } from "../types.ts";

const P = "xero";
const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
const idem = (s: string) => safeKey(s, 120);

/** Xero's DateTime(y,m,d) for a where clause. Only whole numbers from the clock go in. */
export const dateTime = (d: Date) => `DateTime(${d.getUTCFullYear()},${d.getUTCMonth() + 1},${d.getUTCDate()})`;

export async function readInvoices(ctx: Ctx<Settings>, where: string): Promise<Invoice[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: "read invoices", input: { params: { where } } });
  return (r.data?.Invoices ?? []) as Invoice[];
}

export async function readInvoice(ctx: Ctx<Settings>, id: string): Promise<Invoice | undefined> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoice", summary: "read invoice", input: { params: { InvoiceID: guid(id) } } });
  return r.data?.Invoices?.[0] as Invoice | undefined;
}

export async function attachmentCount(ctx: Ctx<Settings>, id: string): Promise<number> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoiceAttachments", summary: "read attachments", input: { params: { InvoiceID: guid(id) } } });
  return (r.data?.Attachments ?? []).length;
}

/** A history note on the invoice, visible inside Xero only. The key stops a retried run from writing it twice. */
export async function noteOn(ctx: Ctx<Settings>, id: string, key: string, text: string): Promise<void> {
  await ctx.draft({ platform: P, op: "accounting.createInvoiceHistory", summary: "note on invoice",
    input: { params: { InvoiceID: guid(id), "Idempotency-Key": idem(`note:${id}:${key}`) }, body: { HistoryRecords: [{ Details: text.slice(0, 500) }] } } });
}

/** A bill payment for the amount owed, from the configured bank account. Queued only: a person approves it. */
export function queuePayment(ctx: Ctx<Settings>, inv: Invoice, amount: number): Promise<string> {
  const key = `pay:${inv.InvoiceID}:${amount}`;
  const text = `Pay ${inv.Contact?.Name ?? "supplier"} ${inv.InvoiceNumber ?? ""} ${money(amount)} from account ${ctx.settings.bank_account_code}`;
  return ctx.queue({ platform: P, op: "accounting.createPayment", key, summary: text,
    input: { params: { "Idempotency-Key": idem(key) },
             body: { Invoice: { InvoiceID: guid(inv.InvoiceID) }, Account: { Code: ctx.settings.bank_account_code }, Date: day(ctx.now), Amount: amount,
                     Reference: String(inv.InvoiceNumber ?? "").slice(0, 255) } } }, text);
}

/** A reminder email for an overdue sales invoice, sent by Xero to the contact. Queued only: a person approves it. */
export function queueReminder(ctx: Ctx<Settings>, inv: Invoice, step: number, text: string): Promise<string> {
  const key = `chase:${inv.InvoiceID}:${step}`;
  return ctx.queue({ platform: P, op: "accounting.emailInvoice", key, summary: text,
    input: { params: { InvoiceID: guid(inv.InvoiceID), "Idempotency-Key": idem(key) } } }, text);
}
