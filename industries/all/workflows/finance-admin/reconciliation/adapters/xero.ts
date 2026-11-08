// Xero: bank lines and invoices to match against, an internal note on a bank line, and a payment applied to an
// authorised invoice (live: queued by the cron, run only on approval). Field names are from Xero's accounting spec
// (BankTransaction, Invoice, Payment, HistoryRecords).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type BankLine, type Settings, INVOICE_NO, ISO_DATE, guid } from "../types.ts";

const P = "xero";
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });

/** Xero returns "/Date(ms+0000)/" in older responses and ISO text in newer ones. Both become YYYY-MM-DD. */
export function xeroDate(v: unknown): string {
  const s = String(v ?? "");
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /\/Date\((-?\d+)/.exec(s);
  if (!m) return "";
  return new Date(Number(m[1])).toISOString().slice(0, 10);
}

function toLine(account: string, t: any): BankLine {
  const type = String(t.Type ?? "");
  const total = Number(t.Total) || 0;
  const sign = type.startsWith("SPEND") ? -1 : 1;
  return {
    id: String(t.BankTransactionID ?? ""), account, date: xeroDate(t.Date), amount: Math.round(sign * total * 100) / 100,
    type, reference: String(t.Reference ?? "").slice(0, 200), reconciled: t.IsReconciled === true, status: String(t.Status ?? ""),
  };
}

/** Every bank line on one account since a date, read a page at a time (Xero returns 100 a page). */
export async function bankLines(ctx: Ctx<Settings>, account: string, since: string): Promise<BankLine[]> {
  const acc = guid(account);
  if (!ISO_DATE.test(since)) throw new Error("reconciliation: bad date");
  const [y, m, d] = since.split("-").map(Number);
  const where = `BankAccount.AccountID==guid("${acc}")&&Date>=DateTime(${y},${m},${d})`;
  const out: BankLine[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getBankTransactions", summary: `bank lines, page ${page}`, input: { params: { where, page } } });
    const rows: any[] = r.data?.BankTransactions ?? [];
    for (const t of rows) out.push(toLine(acc, t));
    if (rows.length < 100) break;
  }
  return out;
}

/** The sales invoice carrying this exact number, or undefined. */
export async function invoiceByNumber(ctx: Ctx<Settings>, number: string): Promise<{ id: string; due: number; status: string } | undefined> {
  if (!INVOICE_NO.test(number)) return undefined;
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `find invoice ${number}`, input: { params: { InvoiceNumbers: [number] } } });
  const hit = (r.data?.Invoices ?? []).find((i: any) => String(i.InvoiceNumber) === number && i.Type === "ACCREC");
  if (!hit) return undefined;
  return { id: guid(hit.InvoiceID), due: Number(hit.AmountDue) || 0, status: String(hit.Status ?? "") };
}

/** An internal note on a bank line. Nobody outside the business sees it. Written once per line by the cron. */
export async function note(ctx: Ctx<Settings>, bankId: string, details: string): Promise<void> {
  const id = guid(bankId);
  await ctx.draft({ platform: P, op: "accounting.createBankTransactionHistoryRecord", summary: `note on bank line ${id}`,
    input: { params: { BankTransactionID: id, ...idem(`note:${id}`) }, body: { HistoryRecords: [{ Details: details.slice(0, 500) }] } } });
}

/** The payment that applies a bank receipt to its invoice. The match cron queues it; it runs only when approved. */
export function paymentAct(account: string, bankId: string, invoiceId: string, date: string, amount: number, reference: string) {
  return {
    platform: P, op: "accounting.createPayment", key: safeKey(`pay:${account}:${bankId}:${invoiceId}`),
    summary: `apply ${amount.toFixed(2)} from bank line ${bankId} to invoice ${invoiceId} in Xero`,
    input: { params: idem(`pay:${bankId}`), body: { Invoice: { InvoiceID: guid(invoiceId) }, Account: { AccountID: guid(account) },
      Date: ISO_DATE.test(date) ? date : "", Amount: amount, Reference: reference.slice(0, 255) } },
  };
}
