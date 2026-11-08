// Xero: the supplier bill that lives in accounting. A bill is drafted (Type ACCPAY, Status DRAFT) and never authorised by
// a cron: the owner checks the supplier's invoice and approves the bill in Xero.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import type { BillLine, Settings } from "../types.ts";
import { day } from "../types.ts";

const P = "xero";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (v: unknown) => { const s = String(v ?? ""); if (!GUID.test(s)) throw new Error("xero: bad id"); return s; };
/** Xero ignores a repeated create with the same key, so a retried run never makes a second bill or contact. */
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });

export const xero = {
  /** Find the supplier by exact name, or create it as a supplier. */
  async supplierContact(ctx: Ctx<Settings>, name: string, code: string): Promise<string> {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: `find supplier ${name}`,
      input: { params: { searchTerm: name, summaryOnly: true } } });
    const hit = (r.data?.Contacts ?? []).find((c: any) => c.IsSupplier && String(c.Name ?? "").toLowerCase() === name.toLowerCase());
    if (hit) return guid(hit.ContactID);
    const made = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create supplier ${name}`,
      input: { params: idem(`supplier:${code}`), body: { Contacts: [{ Name: name.slice(0, 255), IsSupplier: true }] } } });
    return guid(made.data?.Contacts?.[0]?.ContactID);
  },
  /** A DRAFT bill from the receipted lines. The owner matches it to the supplier's invoice and approves it in Xero. */
  async draftBill(ctx: Ctx<Settings>, orderKey: string, contactId: string, reference: string, lines: BillLine[]): Promise<string> {
    const accountCode = ctx.settings.bill_account_code;
    const body = { Invoices: [{ Type: "ACCPAY", Status: "DRAFT", Contact: { ContactID: contactId }, Date: day(ctx.now),
      Reference: reference.slice(0, 255), LineAmountTypes: "Exclusive",
      LineItems: lines.map((l) => ({ ...l, ...(accountCode ? { AccountCode: accountCode } : {}) })) }] };
    const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft bill ${reference}`,
      input: { params: idem(`bill:${orderKey}`), body } });
    return guid(r.data?.Invoices?.[0]?.InvoiceID);
  },
};
