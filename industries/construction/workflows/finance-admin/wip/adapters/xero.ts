// Xero: where the invoices live. Reads invoices, drafts a progress claim as a DRAFT invoice, and builds the
// authorise and email acts that a person approves. Nothing here sends: the cron only ever queues those acts.
import type { Ctx, Act } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import { type Job, type Settings, DAY, day, guid } from "../types.ts";

const P = "xero";
/** Xero ignores a repeated create with the same key, so a retried run never makes a second claim. */
const idem = (s: string) => ({ "Idempotency-Key": safeKey(s, 120) });

/** Authorised and paid sales invoices for one client. */
export async function clientInvoices(ctx: Ctx<Settings>, job: Job): Promise<any[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: `read invoices for ${job.name}`,
    input: { params: { ContactIDs: guid(job.contact_id), Statuses: "AUTHORISED,PAID", page: 1 } } });
  return (r.data?.Invoices ?? []).filter((i: any) => i.Type === "ACCREC");
}

/** Authorised sales invoices across every client, for the chase cron. */
export async function openInvoices(ctx: Ctx<Settings>): Promise<any[]> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: "read authorised invoices",
    input: { params: { Statuses: "AUTHORISED", page: 1 } } });
  return (r.data?.Invoices ?? []).filter((i: any) => i.Type === "ACCREC");
}

/** A progress claim as a DRAFT sales invoice in Xero. The status is fixed to DRAFT here, so nothing leaves the business. */
export async function draftClaim(ctx: Ctx<Settings>, job: Job, claimNo: number, amount: number): Promise<string> {
  const due = new Date(ctx.now.getTime() + (ctx.settings.due_days ?? 14) * DAY);
  const body = { Invoices: [{ Type: "ACCREC", Contact: { ContactID: guid(job.contact_id) }, Date: day(ctx.now), DueDate: day(due),
    Status: "DRAFT", Reference: `${job.id} claim ${claimNo}`.slice(0, 255), LineAmountTypes: "Exclusive",
    LineItems: [{ Description: `Progress claim ${claimNo}: ${job.name}, ${job.percent_complete}% complete`.slice(0, 4000), Quantity: 1, UnitAmount: amount }] }] };
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft progress claim ${claimNo} for ${job.name}`,
    input: { params: idem(`claim:${job.id}:${claimNo}`), body } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}

/** Live act: move a DRAFT invoice to AUTHORISED. Only ever queued. */
export const authoriseAct = (invoiceId: string, label: string): Act => ({ platform: P, op: "accounting.updateInvoice", summary: `authorise ${label}`,
  input: { params: { InvoiceID: guid(invoiceId) }, body: { Invoices: [{ InvoiceID: invoiceId, Status: "AUTHORISED" }] } } });

/** Live act: email an invoice to its client through Xero. Only ever queued. */
export const emailAct = (invoiceId: string, label: string): Act => ({ platform: P, op: "accounting.emailInvoice", summary: `email ${label}`,
  input: { params: { InvoiceID: guid(invoiceId) } } });
