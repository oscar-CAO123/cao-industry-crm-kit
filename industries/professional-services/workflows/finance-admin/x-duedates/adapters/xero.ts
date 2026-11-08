// Xero for due dates: sales invoices still owed (reads), open projects and their deadlines (reads), one internal task per
// project deadline in Xero Projects (drafted), and Xero's own invoice email for an overdue invoice (queued for approval).
// Field names come from the vendor spec in endpoint-map/raw/xero/spec: Invoice (InvoiceID, InvoiceNumber, DueDate,
// AmountDue, Status, Type, Contact) and Project (projectId, name, deadlineUtc, status), Task (taskId, name up to 100 characters).
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../../core/workflows/runtime.ts";
import type { Invoice, Project, Settings } from "../types.ts";

const P = "xero";
const DAY = 864e5;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Xero ids are GUIDs. Anything else is refused before it reaches a path or a body. */
export const guid = (v: unknown, what: string): string => {
  const s = String(v ?? "");
  if (!GUID.test(s)) throw new Error(`x-duedates: bad ${what}`);
  return s;
};

/** Xero returns dates as "/Date(1767225600000+0000)/" or as ISO text. Returns YYYY-MM-DD, or null when neither reads. */
export function xeroDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ms = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(v);
  let t: number;
  if (ms) t = Number(ms[1]);
  else if (/^\d{4}-\d{2}-\d{2}/.test(v)) t = Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
  else return null;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export const todayUtc = (now: Date) => now.toISOString().slice(0, 10);
/** Whole days from one YYYY-MM-DD to another (to minus from). */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** A whole-number setting between lo and hi. Missing uses the default; a value outside the range is refused. */
export function intSetting(v: unknown, lo: number, hi: number, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < lo || n > hi) throw new Error(`x-duedates: setting must be a whole number from ${lo} to ${hi}`);
  return n;
}

/** Sales invoices still owed money (AUTHORISED, AR). Reads only; pages through Xero's 100 per page. */
export async function awaitingPayment(ctx: Ctx<Settings>): Promise<Invoice[]> {
  const today = todayUtc(ctx.now), out: Invoice[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getInvoices", summary: "invoices awaiting payment",
      input: { params: { where: 'Status=="AUTHORISED" AND Type=="ACCREC"', page } } });
    const rows: any[] = Array.isArray(r.data?.Invoices) ? r.data.Invoices : [];
    for (const i of rows) {
      const due = xeroDay(i.DueDate), owed = Number(i.AmountDue ?? 0);
      if (!due || !(owed > 0)) continue;
      out.push({ id: guid(i.InvoiceID, "invoice id"), number: String(i.InvoiceNumber ?? ""), contact: String(i.Contact?.Name ?? ""),
                 due, amount_due: owed, days_overdue: daysBetween(due, today) });
    }
    if (rows.length < 100) break;
  }
  return out;
}

/** Open projects with their deadline. Reads only; pages 50 at a time. */
export async function openProjects(ctx: Ctx<Settings>): Promise<Project[]> {
  const out: Project[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "projects.getProjects", summary: "open projects",
      input: { params: { states: "INPROGRESS", page, pageSize: 50 } } });
    const rows: any[] = Array.isArray(r.data?.items) ? r.data.items : [];
    for (const p of rows) {
      out.push({ id: guid(p.projectId, "project id"), name: String(p.name ?? "").slice(0, 200), deadline: xeroDay(p.deadlineUtc), status: String(p.status ?? "") });
    }
    if (rows.length < 50) break;
  }
  return out;
}

/** An internal task in Xero Projects that names the deadline. Xero ignores a repeated Idempotency-Key, so a re-run never makes a second task. */
export async function draftDeadlineTask(ctx: Ctx<Settings>, p: Project, deadline: string): Promise<string> {
  const pid = guid(p.id, "project id");
  const r = await ctx.draft<any>({ platform: P, op: "projects.createTask", summary: `task for ${p.name} due ${deadline}`,
    input: { params: { projectId: pid, "Idempotency-Key": safeKey(`task:${pid}:${deadline}`) },
             body: { name: `Due ${deadline}: ${p.name}`.slice(0, 100) } } });
  return guid(r.data?.taskId, "task id");
}

/** The live act for an overdue invoice: Xero emails the invoice to its contact. Queued by the chase cron; sent only on approval. */
export function chaseAct(inv: Invoice, step: number): Act {
  const id = guid(inv.id, "invoice id");
  const key = safeKey(`chase:${id}:${step}`);
  const money = inv.amount_due.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
  return { platform: P, op: "accounting.emailInvoice", key, input: { params: { InvoiceID: id, "Idempotency-Key": key } },
           summary: `email invoice ${inv.number} (${money} owed, ${inv.days_overdue} days overdue) to ${inv.contact || "the contact"}` };
}
