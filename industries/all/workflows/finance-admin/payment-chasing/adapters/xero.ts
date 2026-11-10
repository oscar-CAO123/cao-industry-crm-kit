// Xero: where the unpaid invoices live. Reads the authorised sales invoices, the client's contact details and the
// invoice PDF. Xero cannot send the reminder itself, so the email goes out through the mailbox (see microsoft-365.ts),
// and the invoice history note that records the reminder is part of the same approval.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Contact, type InvoiceRow, EMAIL, GUID, plain, parseXeroDate } from "../types.ts";

const P = "xero";
const MAX_PAGES = 20;
const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };

/** Every authorised sales invoice (partly paid ones included), with the ids of all of them so a missing one can be spotted. */
export async function openInvoices(ctx: Ctx<Settings>): Promise<{ rows: InvoiceRow[]; ids: Set<string> }> {
  const rows: InvoiceRow[] = [], ids = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `read authorised invoices, page ${page}`,
      input: { params: { Statuses: "AUTHORISED", page, pageSize: 100 } } });
    const list: any[] = r.data?.Invoices ?? [];
    for (const i of list) {
      const id = String(i.InvoiceID ?? "");
      if (!GUID.test(id) || i.Type !== "ACCREC") continue;
      ids.add(id);
      const due = parseXeroDate(i.DueDate);
      if (!due) continue;
      rows.push({ id, number: plain(i.InvoiceNumber ?? id, 40), contact_id: String(i.Contact?.ContactID ?? ""), contact_name: plain(i.Contact?.Name, 120),
        amount_due: Math.round(Number(i.AmountDue ?? 0) * 100) / 100, due, days_overdue: 0, seen: "" });
    }
    if (list.length < 100) break;
  }
  return { rows, ids };
}

/** The client's first name and email. A contact with no valid email is returned without one, and nothing is drafted for it. */
export async function contactOf(ctx: Ctx<Settings>, contactId: string): Promise<Contact> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getContact", summary: "read client contact",
    input: { params: { ContactID: guid(contactId) } } });
  const c = r.data?.Contacts?.[0] ?? {};
  const name = plain(c.Name, 120);
  return { first: plain(c.FirstName || name.split(" ")[0], 60), name, email: c.EmailAddress && EMAIL.test(c.EmailAddress) ? c.EmailAddress : undefined };
}

/** The invoice as a PDF, base64, for attaching to the reminder draft. */
export async function invoicePdfBase64(ctx: Ctx<Settings>, invoiceId: string): Promise<string> {
  const pdf = await ctx.draft<ArrayBuffer>({ platform: P, op: "accounting.getInvoiceAsPdf", summary: "invoice PDF",
    input: { params: { InvoiceID: guid(invoiceId) }, binary: true } });
  return Buffer.from(pdf.data as ArrayBuffer).toString("base64");
}

/** The live act that records a reminder on the invoice in Xero. It runs only after the reminder itself has been sent. */
export function historyAct(invoiceId: string, stage: number, to: string, key: string): Act {
  return { platform: P, op: "accounting.createInvoiceHistory", key, summary: `note reminder ${stage} on the invoice in Xero`,
    input: { params: { InvoiceID: guid(invoiceId), "Idempotency-Key": safeKey(`chase-note:${invoiceId}:${stage}`, 120) },
             body: { HistoryRecords: [{ Details: plain(`Payment reminder ${stage} emailed to ${to}`, 255) }] } } };
}
