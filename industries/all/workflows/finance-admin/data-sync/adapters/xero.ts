// Xero: contacts and supplier bills. Reading and creating a contact are internal records (draft). Authorising a bill is
// live: it is only ever queued here, and runs when a person approves it.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Bill, type Contact, type Settings, GUID, clean, dayTime } from "../types.ts";

const P = "xero";
const PAGE = 100;   // Xero returns up to 100 rows a page

/** A Xero id must be a GUID. Anything else is skipped, never written. */
export const xeroId = (v: unknown): string | undefined => (GUID.test(String(v ?? "")) ? String(v) : undefined);
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });

/** Active contacts changed since the last run (Xero's If-Modified-Since header), page by page. */
export async function contactsSince(ctx: Ctx<Settings>, since?: string): Promise<Contact[]> {
  const out: Contact[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: `read contacts, page ${page}`,
      input: { params: { page, where: 'ContactStatus=="ACTIVE"', ...(since ? { "If-Modified-Since": since } : {}) } } });
    const rows: any[] = r.data?.Contacts ?? [];
    for (const c of rows) {
      const id = xeroId(c.ContactID), name = clean(c.Name);
      if (id && name) out.push({ id, name });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** The Xero contact whose name matches exactly (case-insensitive). Two exact matches is a conflict: nothing is picked. */
export async function contactByName(ctx: Ctx<Settings>, name: string): Promise<{ id?: string; conflict: boolean }> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: "find contact by name",
    input: { params: { searchTerm: name } } });
  const want = name.toLowerCase();
  const hits = (r.data?.Contacts ?? []).filter((c: any) => clean(c.Name).toLowerCase() === want && xeroId(c.ContactID));
  if (hits.length === 1) return { id: xeroId(hits[0].ContactID), conflict: false };
  return { conflict: hits.length > 1 };
}

/** Create a contact in Xero. The key makes a retried run reuse the same contact instead of making a second one. */
export async function createContact(ctx: Ctx<Settings>, c: { name: string; key: string }): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createContacts", summary: `create contact ${c.name}`,
    input: { params: idem(c.key), body: { Contacts: [{ Name: clean(c.name) }] } } });
  const id = xeroId(r.data?.Contacts?.[0]?.ContactID);
  if (!id) throw new Error("xero: contact was not created");
  return id;
}

/** Supplier bills in DRAFT. They came in from a billing system and wait for a person to authorise them. */
export async function draftBills(ctx: Ctx<Settings>): Promise<Bill[]> {
  const out: Bill[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `read draft bills, page ${page}`,
      input: { params: { page, where: 'Type=="ACCPAY" AND Status=="DRAFT"' } } });
    const rows: any[] = r.data?.Invoices ?? [];
    for (const b of rows) {
      const id = xeroId(b.InvoiceID);
      if (id) out.push({ id, number: clean(b.InvoiceNumber, 60), supplier: clean(b.Contact?.Name, 120), total: Number(b.Total) || 0 });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** The live act a person approves: move one bill from DRAFT to AUTHORISED, so it can be paid. */
export function authoriseAct(b: Bill) {
  return { platform: P, op: "accounting.updateInvoice", summary: `authorise bill ${b.number} from ${b.supplier}`, key: `bill:${b.id}`,
    input: { params: { InvoiceID: b.id, ...idem(`bill-authorise:${b.id}`) }, body: { Invoices: [{ InvoiceID: b.id, Status: "AUTHORISED" }] } } };
}
