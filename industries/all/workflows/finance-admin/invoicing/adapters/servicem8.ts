// ServiceM8: where the completed work is. A job in Completed status with its materials is what gets invoiced, and a
// job payment is what the trade took on site. Field names come from ServiceM8's official spec (Job, JobMaterial,
// JobPayment, CompanyContact). This adapter only reads, plus one queued update that marks the job invoiced.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Contact, type Line, type Settings, EMAIL, UUID, uuid } from "../types.ts";

const P = "servicem8";
const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** Completed jobs not yet marked invoiced in ServiceM8. */
export async function completedJobs(ctx: Ctx<Settings>): Promise<any[]> {
  return (await list<any>(ctx, "servicem8-api.listJobs", "status eq 'Completed'"))
    .filter((j) => j.active !== 0 && UUID.test(String(j.uuid)) && String(j.invoice_sent) !== "1")
    .slice(0, 50);
}

/** The job's materials as invoice lines. bad counts rows with no usable quantity or price. */
export async function jobLines(ctx: Ctx<Settings>, job: string): Promise<{ lines: Line[]; bad: number }> {
  const rows = (await list<any>(ctx, "servicem8-api.listJobMaterials", `job_uuid eq '${uuid(job)}'`)).filter((m) => m.active !== 0);
  const lines: Line[] = [];
  let bad = 0;
  for (const m of rows) {
    const qty = Number(m.quantity), unitPrice = Number(m.price);
    if (!(qty > 0) || qty > 100000 || !Number.isFinite(unitPrice) || unitPrice < 0) { bad++; continue; }
    lines.push({ name: String(m.name ?? "Item").slice(0, 200), qty, unitPrice });
  }
  return { lines, bad };
}

/** The primary contact on the job's customer company. Empty when none is on file. */
export async function contactFor(ctx: Ctx<Settings>, companyUuid?: string): Promise<Contact> {
  if (!companyUuid || !UUID.test(companyUuid)) return {};
  const cs = await list<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${companyUuid}'`);
  const c = cs.find((x) => String(x.is_primary_contact) === "1") ?? cs[0] ?? {};
  return {
    name: [c.first, c.last].filter(Boolean).join(" ") || undefined,
    email: EMAIL.test(String(c.email ?? "")) ? String(c.email) : undefined,
  };
}

/** Payments the trade has taken on this job. */
export async function paymentsFor(ctx: Ctx<Settings>, job: string): Promise<{ uuid: string; amount: string }[]> {
  return (await list<any>(ctx, "servicem8-api.listJobPayments", `job_uuid eq '${uuid(job)}'`))
    .filter((p) => p.active !== 0 && UUID.test(String(p.uuid)))
    .map((p) => ({ uuid: String(p.uuid), amount: String(p.amount ?? "") }));
}

/** Queued after the invoice email goes: marks the job invoiced in ServiceM8. Never run by a cron. */
export const markInvoicedAct = (job: string): Act => ({
  platform: P, op: "servicem8-api.updateJobs", summary: `mark job ${job} invoice sent in ServiceM8`,
  input: { params: { uuid: uuid(job) }, body: { invoice_sent: 1 } },
});
