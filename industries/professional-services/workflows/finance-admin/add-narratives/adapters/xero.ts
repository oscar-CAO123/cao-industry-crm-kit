// Xero for billing narratives: Xero Projects time entries and tasks (reads), a DRAFT sales invoice (draft), and the
// authorisation of that invoice (live: only ever queued, a person approves it).
import { safeKey, type Act, type Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Platform, guid, isGuid, day, DAY } from "../types.ts";

const P: Platform = "xero";
const PAGE = 100;
const MAX_PAGES = 20;

export interface RawEntry { id: string; project_id: string; task_id: string; date: string; minutes: number; description: string }

/** Chargeable entries still ACTIVE (not yet invoiced) for one project, dated since the window start. Pages until a short page. */
export async function timeEntries(ctx: Ctx<Settings>, projectId: string, since: string): Promise<RawEntry[]> {
  const pid = guid(projectId), out: RawEntry[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "projects.getTimeEntries", summary: `time entries, project ${pid}, page ${page}`,
      input: { params: { projectId: pid, states: "ACTIVE", isChargeable: true, dateAfterUtc: since, page, pageSize: PAGE } } });
    const items: any[] = Array.isArray(r.data?.items) ? r.data.items : [];
    for (const i of items) {
      if (i?.status && i.status !== "ACTIVE") continue;               // the filter is also checked here
      const minutes = Number(i.duration);
      if (!isGuid(i.timeEntryId) || !Number.isInteger(minutes) || minutes <= 0) continue;
      out.push({ id: String(i.timeEntryId), project_id: pid, task_id: String(i.taskId ?? ""), date: String(i.dateUtc ?? "").slice(0, 10),
                 minutes, description: String(i.description ?? "").slice(0, 500) });
    }
    if (items.length < PAGE) break;
  }
  return out;
}

/** The client's name and Xero contact. contact is undefined when the project has no valid contact. */
export async function project(ctx: Ctx<Settings>, projectId: string): Promise<{ name: string; contact?: string }> {
  const r = await ctx.draft<any>({ platform: P, op: "projects.getProject", summary: `project ${projectId}`, input: { params: { projectId: guid(projectId) } } });
  const c = String(r.data?.contactId ?? "");
  return { name: String(r.data?.name ?? "client").slice(0, 120), contact: isGuid(c) ? c : undefined };
}

/** Hourly rate per task id, from the project's tasks. */
export async function taskRates(ctx: Ctx<Settings>, projectId: string): Promise<Record<string, number>> {
  const r = await ctx.draft<any>({ platform: P, op: "projects.getTasks", summary: `tasks, project ${projectId}`,
    input: { params: { projectId: guid(projectId), pageSize: PAGE } } });
  const out: Record<string, number> = {};
  for (const t of Array.isArray(r.data?.items) ? r.data.items : []) {
    const v = Number(t?.rate?.value);
    if (isGuid(t?.taskId) && Number.isFinite(v) && v >= 0) out[String(t.taskId)] = v;
  }
  return out;
}

export interface DraftLine { description: string; quantity: number; unit_amount: number }

/** One DRAFT sales invoice in Xero with the narrative lines. The Idempotency-Key makes a repeated run return the same invoice. */
export async function draftInvoice(ctx: Ctx<Settings>, p: { contact: string; key: string; reference: string; lines: DraftLine[] }): Promise<string> {
  const due = new Date(ctx.now.getTime() + (ctx.settings.payment_terms_days ?? 14) * DAY);
  const account = ctx.settings.invoice_account_code ? { AccountCode: String(ctx.settings.invoice_account_code) } : {};
  const r = await ctx.draft<any>({ platform: P, op: "accounting.createInvoices", summary: `draft invoice ${p.reference}`,
    input: { params: { "Idempotency-Key": safeKey(`invoice:${p.key}`, 120) },
      body: { Invoices: [{ Type: "ACCREC", Contact: { ContactID: guid(p.contact) }, Date: day(ctx.now), DueDate: day(due), Status: "DRAFT",
        LineAmountTypes: "Exclusive", Reference: p.reference.slice(0, 255),
        LineItems: p.lines.map((l) => ({ Description: l.description, Quantity: l.quantity, UnitAmount: l.unit_amount, ...account })) }] } } });
  return guid(r.data?.Invoices?.[0]?.InvoiceID);
}

/** The act that authorises a draft invoice. Never run by a cron: it is queued, and a person approves it. */
export function authoriseAct(invoiceId: string, summary: string): Act {
  const id = guid(invoiceId);
  return { platform: P, op: "accounting.updateInvoice", summary, key: `authorise:${id}`,
    input: { params: { InvoiceID: id, "Idempotency-Key": safeKey(`authorise:${id}`, 120) }, body: { Invoices: [{ InvoiceID: id, Status: "AUTHORISED" }] } } };
}

/** The invoice's status in Xero (DRAFT, AUTHORISED, PAID, VOIDED, DELETED...). */
export async function invoiceStatus(ctx: Ctx<Settings>, invoiceId: string): Promise<string | undefined> {
  const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoice", summary: "invoice status", input: { params: { InvoiceID: guid(invoiceId) } } });
  const s = r.data?.Invoices?.[0]?.Status;
  return typeof s === "string" ? s : undefined;
}
