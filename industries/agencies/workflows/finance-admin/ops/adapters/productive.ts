// Productive: the agency's project, budget and invoice record. JSON:API bodies; field names from the vendor's OpenAPI spec
// (endpoint-map/raw/productive/spec). Reads are unfiltered because the kit cannot send Productive's filter[...] syntax yet.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ID, clean, type BudgetRow, type Brief, type Invoice, type Settings } from "../types.ts";

const P = "productive";
type Row = { id: string; attributes?: Record<string, any> };
const rows = (r: { data: any }): Row[] => (Array.isArray(r?.data?.data) ? r.data.data : []);
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const numericId = (v: unknown): string | undefined => { const s = String(v ?? ""); return ID.test(s) ? s : undefined; };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Deals in the brief status, read from every deal the server returns. */
export async function newBriefs(ctx: Ctx<Settings>): Promise<Brief[]> {
  const want = ctx.settings.productive.brief_deal_status_id;
  const r = await ctx.draft<any>({ platform: P, op: "deals-index", summary: "read deals for new briefs" });
  return rows(r)
    .filter((d) => numericId(d.id) && String(d.attributes?.deal_status_id ?? "") === want)
    .map((d): Brief => ({
      id: String(d.id), title: clean(d.attributes?.name) || `Deal ${d.id}`, company_id: numericId(d.attributes?.company_id),
      status: "new", seen: ctx.now.toISOString(),
    }));
}

/** An internal task on the ops board. Nothing is assigned, so nobody outside the business is notified. */
export async function opsTask(ctx: Ctx<Settings>, title: string, description: string): Promise<string> {
  const p = ctx.settings.productive;
  const relationships: Record<string, unknown> = { project: { data: { type: "projects", id: p.ops_project_id } } };
  if (p.task_list_id) relationships.task_list = { data: { type: "task_lists", id: p.task_list_id } };
  const r = await ctx.draft<any>({
    platform: P, op: "tasks-create", summary: clean(title, 120),
    input: { body: { data: { type: "tasks", attributes: { title: clean(title, 200), description: clean(description, 2000) }, relationships } } },
  });
  const id = numericId(r.data?.data?.id);
  if (!id) throw new Error("productive: task created without an id");
  return id;
}

/** Budget use per project. A project with several budgets keeps its highest use. */
export async function budgets(ctx: Ctx<Settings>): Promise<BudgetRow[]> {
  const r = await ctx.draft<any>({ platform: P, op: "reports-budget_reports-index", summary: "read budget reports" });
  const byProject = new Map<string, BudgetRow>();
  for (const x of rows(r)) {
    const pid = numericId(x.attributes?.project_id);
    if (!pid) continue;
    const row: BudgetRow = { project_id: pid, budget_usage: num(x.attributes?.budget_usage), budgeted_time: num(x.attributes?.budgeted_time), billable_time: num(x.attributes?.billable_time) };
    const prev = byProject.get(pid);
    if (!prev || row.budget_usage > prev.budget_usage) byProject.set(pid, row);
  }
  return [...byProject.values()];
}

/** Invoices with no sent date whose delivery date has passed. */
export async function invoicesDue(ctx: Ctx<Settings>, today: string): Promise<Invoice[]> {
  const r = await ctx.draft<any>({ platform: P, op: "invoices-index", summary: "read invoices" });
  return rows(r)
    .filter((i) => numericId(i.id) && !i.attributes?.sent_on && DATE.test(String(i.attributes?.delivery_on ?? "")) && String(i.attributes!.delivery_on) <= today)
    .map((i): Invoice => ({ id: String(i.id), number: clean(i.attributes?.number, 40), delivery_on: String(i.attributes!.delivery_on) }));
}

/** Marking an invoice sent is live: it waits in the approval queue. The summary says what it does and does not do. */
export function markSentAct(inv: Invoice, today: string): Act {
  return {
    platform: P, op: "invoices-update", key: `sent:${inv.id}`,
    summary: `mark invoice ${inv.number || inv.id} sent in Productive (this sets the sent date; check the client has it)`,
    input: { params: { id: inv.id }, body: { data: { type: "invoices", id: inv.id, attributes: { sent_on: today } } } },
  };
}
