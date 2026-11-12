import { composioEnabled } from "../../lib/connection-provider.ts";
// Xero helper.
//
// Source of each function, from the reference CRM at commit 28aa5d91 unless marked NEW:
//   accessToken        lib/xero.ts getXeroToken (single-use refresh tokens, retry once on invalid_grant).
//                      The CRM keeps the token in its database config table; the kit uses its token store.
//   listInvoices       lib/xero-invoices.ts fetchAccrecInvoices (Type in a where clause, 100 a page)
//   findOrCreateContact, createInvoice, getInvoicePdf   app/api/pipeline/[id]/send-invoice/route.ts.
//                      Changed on purpose: Xero's own invoice email is not offered; a person sends it.
//                      Changed on purpose: the CRM creates invoices AUTHORISED; the kit defaults to DRAFT.
//   toInvoiceRecord    lib/xero-invoices.ts exGst idea, as a shared record
//   listContacts, listPayments, runReport   NEW: from Xero's API docs, not yet run in production
// The original invoice classes, fee table and lead matching are left out.
//
// Keys: XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_TENANT_ID, and a first XERO_REFRESH_TOKEN.
// Xero refresh tokens are single use, so each new one is saved to the token store at once. If two
// jobs refresh together one gets invalid_grant; it waits, re-reads the store and tries once more.
// Invoices are created as DRAFT unless the caller asks otherwise, so nothing reaches a customer by
// accident.

import { call, type AppSpec } from "../../lib/http.ts";
import { secret, optional, tokenStore } from "../../lib/secrets.ts";
import { collect } from "../../lib/paging.ts";

export const spec: AppSpec = {
  app: "xero",
  hosts: ["api.xero.com", "identity.xero.com"],
  readPosts: ["identity.xero.com/connect/token"],
};

const API = "https://api.xero.com/api.xro/2.0";
const STORE_KEY = "xero.refresh_token";
let cached: { token: string; until: number } | null = null;

async function refresh(refreshToken: string): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string }> {
  const basic = Buffer.from(`${secret("XERO_CLIENT_ID")}:${secret("XERO_CLIENT_SECRET")}`).toString("base64");
  try {
    const r = await call<any>(spec, {
      method: "POST", url: "https://identity.xero.com/connect/token",
      headers: { Authorization: `Basic ${basic}` },
      form: { grant_type: "refresh_token", refresh_token: refreshToken },
      retries: 1,
    });
    return r.data;
  } catch (e: any) {
    if (e?.status === 400) return { error: "invalid_grant" };
    throw e;
  }
}

export async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const store = tokenStore();
  const first = (await store.get(STORE_KEY)) ?? optional("XERO_REFRESH_TOKEN");
  if (!first) throw new Error("No Xero refresh token. Connect Xero once and save the refresh token as XERO_REFRESH_TOKEN.");
  let data = await refresh(first);
  if (!data.access_token && data.error === "invalid_grant") {
    await new Promise((r) => setTimeout(r, 2000));
    const fresh = await store.get(STORE_KEY);
    if (fresh && fresh !== first) data = await refresh(fresh);
  }
  if (!data.access_token) throw new Error("Xero token refresh failed. The refresh token may have expired: reconnect Xero.");
  if (data.refresh_token) await store.set(STORE_KEY, data.refresh_token);
  cached = { token: data.access_token, until: Date.now() + (data.expires_in ?? 1800) * 1000 };
  return cached.token;
}

/** The token and tenant together, the shape the CRM's getXeroToken returns. */
export async function getToken(): Promise<{ accessToken: string; tenantId: string }> {
  return { accessToken: await accessToken(), tenantId: secret("XERO_TENANT_ID") };
}

/** For tests. */
export function clearTokenCache(): void { cached = null; }

async function headers(): Promise<Record<string, string>> {
  return { ...(composioEnabled("xero") ? {} : { Authorization: `Bearer ${await accessToken()}` }), "Xero-Tenant-Id": secret("XERO_TENANT_ID") };
}

export interface XeroContact { ContactID: string; Name: string; EmailAddress?: string; Phones?: { PhoneNumber?: string; PhoneType?: string }[]; TaxNumber?: string; IsCustomer?: boolean; IsSupplier?: boolean }
export interface XeroInvoice {
  InvoiceID: string; InvoiceNumber?: string; Type: "ACCREC" | "ACCPAY"; Status: string;
  Contact: { ContactID: string; Name: string };
  LineItems: { Description?: string; Quantity?: number; UnitAmount?: number; AccountCode?: string; TaxType?: string }[];
  SubTotal: number; TotalTax: number; Total: number; AmountDue?: number;
  DateString?: string; DueDateString?: string; FullyPaidOnDate?: string; Reference?: string;
}

/** Xero pages hold 100. A short page is the last. */
async function pagedList<T>(path: string, key: string, query: Record<string, string | undefined>, modifiedSince?: string): Promise<T[]> {
  const h = await headers();
  if (modifiedSince) h["If-Modified-Since"] = modifiedSince;
  return collect<T, number>(1, async (page) => {
    let r;
    try { r = await call<any>(spec, { url: `${API}/${path}`, headers: h, query: { ...query, page, pageSize: 100 } }); }
    catch (e: any) { if (modifiedSince && e?.status === 304) return { items: [], next: null }; throw e; } // nothing changed since then
    const items: T[] = r.data?.[key] ?? [];
    return { items, next: items.length < 100 ? null : page + 1 };
  }, { maxPages: 500 });
}

export function listContacts(opts: { modifiedSince?: string; where?: string } = {}): Promise<XeroContact[]> {
  return pagedList<XeroContact>("Contacts", "Contacts", { where: opts.where }, opts.modifiedSince);
}

/** Type goes in a where clause: Xero ignores a plain ?Type= and returns bills too. */
export function listInvoices(opts: { type?: "ACCREC" | "ACCPAY"; statuses?: string[]; modifiedSince?: string } = {}): Promise<XeroInvoice[]> {
  return pagedList<XeroInvoice>("Invoices", "Invoices", {
    where: opts.type ? `Type=="${opts.type}"` : undefined,
    Statuses: opts.statuses?.join(","),
  }, opts.modifiedSince).then((list) => (opts.type ? list.filter((i) => i.Type === opts.type) : list));
}

export function listPayments(opts: { modifiedSince?: string } = {}): Promise<unknown[]> {
  return pagedList("Payments", "Payments", {}, opts.modifiedSince);
}

const q = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Finds a contact by email, or creates one. Sets the ABN as the tax number. Needs KIT_ALLOW_WRITES=1 to create or update. */
export async function findOrCreateContact(c: { name: string; company?: string; email?: string; abn?: string }): Promise<string> {
  const h = await headers();
  const tax = c.abn?.trim() || undefined;
  if (c.email) {
    const r = await call<any>(spec, { url: `${API}/Contacts`, headers: h, query: { where: `EmailAddress=="${q(c.email)}"` } });
    const hit = r.data?.Contacts?.[0];
    if (hit) {
      if (tax && hit.TaxNumber !== tax) await call(spec, { method: "POST", url: `${API}/Contacts`, headers: h, json: { Contacts: [{ ContactID: hit.ContactID, TaxNumber: tax }] } });
      return hit.ContactID;
    }
  }
  const parts = c.name.trim().split(/\s+/);
  const r = await call<any>(spec, {
    method: "POST", url: `${API}/Contacts`, headers: h,
    json: { Contacts: [{ Name: c.company || c.name, FirstName: parts[0] ?? c.name, LastName: parts.slice(1).join(" "), EmailAddress: c.email, ...(tax ? { TaxNumber: tax } : {}) }] },
  });
  const made = r.data?.Contacts?.[0] ?? r.data?.Elements?.[0]?.Contacts?.[0];
  if (!made?.ContactID) throw new Error("Xero did not return the new contact");
  return made.ContactID;
}

export interface LineItem { Description: string; Quantity: number; UnitAmount: number; AccountCode?: string; TaxType?: string }

/**
 * Creates a sales invoice, GST exclusive. Needs KIT_ALLOW_WRITES=1. DRAFT by default, so it does
 * not reach the customer until someone approves it in Xero. AccountCode 200 (Sales) and TaxType
 * OUTPUT (GST on income) are the Australian defaults the CRM uses; check them against the client's
 * chart of accounts.
 */
export async function createInvoice(o: { contactId: string; lines: LineItem[]; dueDate: string; reference?: string; status?: "DRAFT" | "SUBMITTED" | "AUTHORISED" }): Promise<XeroInvoice> {
  const r = await call<any>(spec, {
    method: "POST", url: `${API}/Invoices`, headers: await headers(),
    json: { Invoices: [{
      Type: "ACCREC", Contact: { ContactID: o.contactId }, DueDate: o.dueDate, Reference: o.reference, Status: o.status ?? "DRAFT", LineAmountTypes: "Exclusive",
      LineItems: o.lines.map((l) => ({ AccountCode: "200", TaxType: "OUTPUT", ...l })),
    }] },
  });
  const made = r.data?.Invoices?.[0] ?? r.data?.Elements?.[0]?.Invoices?.[0]; // Xero answers in either shape, as the CRM reads it
  if (!made?.InvoiceID) throw new Error("xero: no invoice id came back, so the invoice cannot be confirmed");
  return made;
}

/** An invoice as a PDF, as the CRM fetches it before attaching it to an email draft. */
export async function getInvoicePdf(invoiceId: string): Promise<Buffer> {
  const r = await call<ArrayBuffer>(spec, { url: `${API}/Invoices/${encodeURIComponent(invoiceId)}`, headers: { ...(await headers()), Accept: "application/pdf" }, binary: true });
  return Buffer.from(r.data);
}

/** Reports such as ProfitAndLoss, BalanceSheet, AgedReceivablesByContact, TrialBalance. */
export async function runReport(name: string, params: Record<string, string> = {}): Promise<unknown> {
  if (!/^[A-Za-z]+$/.test(name)) throw new Error(`bad report name ${name}`);
  const r = await call<any>(spec, { url: `${API}/Reports/${name}`, headers: await headers(), query: params });
  return r.data?.Reports?.[0] ?? null;
}

/** The kit's shared invoice record. Amounts are ex GST, with GST beside them. */
export function toInvoiceRecord(i: XeroInvoice) {
  return {
    id: i.InvoiceID, number: i.InvoiceNumber ?? null, contact_id: i.Contact?.ContactID ?? null, status: i.Status,
    total_ex_gst: i.SubTotal, gst: i.TotalTax, total: i.Total, due: i.DueDateString ?? null,
    paid_at: i.FullyPaidOnDate ?? null, amount_due: i.AmountDue ?? null,
  };
}

export function toContactRecord(c: XeroContact) {
  return { id: c.ContactID, name: c.Name, email: c.EmailAddress ?? null, phone: c.Phones?.find((p) => p.PhoneNumber)?.PhoneNumber ?? null, abn: c.TaxNumber ?? null };
}
