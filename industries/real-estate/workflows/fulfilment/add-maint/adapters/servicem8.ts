// ServiceM8 for maintenance dispatch. A maintenance request is a Job in "Quote" status when it is logged; the owner's
// go-ahead moves it to "Work Order"; allocating it to a staff member is the dispatch step. Field names come from
// ServiceM8's official spec (Job, CompanyContact, StaffMember, JobAllocation, EmailMessage, SMSMessage).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Contact, type Job, type Settings, UUID, EMAIL, PHONE, esc } from "../types.ts";

const P = "servicem8";
const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("servicem8: bad uuid"); return s; };
const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** Australian mobiles are stored as 04xx xxx xxx; SMS needs +614xxxxxxxx. */
function auMobile(v: unknown): string | undefined {
  const d = String(v ?? "").replace(/[\s()-]/g, "");
  const e164 = /^04\d{8}$/.test(d) ? `+61${d.slice(1)}` : d;
  return PHONE.test(e164) ? e164 : undefined;
}

async function contactFor(ctx: Ctx<Settings>, companyUuid?: string): Promise<Contact> {
  if (!companyUuid || !UUID.test(companyUuid)) return {};
  const cs = await list<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${companyUuid}' and active eq 1`);
  const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
  return { name: [c.first, c.last].filter(Boolean).join(" ") || undefined,
           email: EMAIL.test(c.email ?? "") ? c.email : undefined, phone: auMobile(c.mobile) };
}

/** A ServiceM8 job as the workflow records it, with its primary contact. */
export async function jobRecord(ctx: Ctx<Settings>, j: any): Promise<Job> {
  return { job_uuid: uuid(j.uuid), title: String(j.job_description ?? "Maintenance request").slice(0, 120),
           address: String(j.job_address ?? "").slice(0, 200), contact: await contactFor(ctx, j.company_uuid),
           status: "new", received: String(j.date ?? ctx.now.toISOString()) };
}

export const servicem8 = {
  id: P,
  /** Jobs logged as Quote: new maintenance requests. */
  async openJobs(ctx: Ctx<Settings>): Promise<Job[]> {
    const jobs = (await list<any>(ctx, "servicem8-api.listJobs", "active eq 1 and status eq 'Quote'")).filter((j) => UUID.test(j.uuid)).slice(0, 50);
    const out: Job[] = [];
    for (const j of jobs) out.push(await jobRecord(ctx, j));
    return out;
  },
  /** Jobs the owner has approved (Work Order). */
  async workOrders(ctx: Ctx<Settings>): Promise<any[]> {
    return (await list<any>(ctx, "servicem8-api.listJobs", "active eq 1 and status eq 'Work Order'")).filter((j) => UUID.test(j.uuid)).slice(0, 50);
  },
  /** One job by uuid, for a status check. */
  async jobByUuid(ctx: Ctx<Settings>, job: string): Promise<any | undefined> {
    const [j] = await list<any>(ctx, "servicem8-api.listJobs", `uuid eq '${uuid(job)}'`);
    return j;
  },
  jobRecord,
  /** True when the configured staff member exists and is active. */
  async staffActive(ctx: Ctx<Settings>, staff: string): Promise<boolean> {
    const s = uuid(staff);
    return (await list<any>(ctx, "servicem8-api.listStaffMembers", "active eq 1")).some((x) => x.uuid === s);
  },
  /** True when the job already has a live allocation, so a re-run never allocates it twice. */
  async hasAllocation(ctx: Ctx<Settings>, job: string): Promise<boolean> {
    return (await list<any>(ctx, "servicem8-api.listJobAllocations", `job_uuid eq '${uuid(job)}' and active eq 1`)).length > 0;
  },
  /** The approval-gated act: allocate the job to a staff member. Used only through ctx.queue. */
  allocateAct(job: string, staff: string, summary: string) {
    return { platform: P, op: "servicem8-api.createJobAllocations", key: `dispatch:${uuid(job)}`, summary,
             input: { body: { job_uuid: uuid(job), staff_uuid: uuid(staff) } } };
  },
  /** Approval-gated email. The html is escaped text only. */
  emailAct(job: string, to: string, subject: string, text: string, key: string, summary: string) {
    if (!EMAIL.test(to)) throw new Error("servicem8: bad email address");
    return { platform: P, op: "messaging-api.send_email", key, summary,
             input: { body: { to, subject, htmlBody: `<p>${esc(text)}</p>`, regardingJobUUID: uuid(job) } } };
  },
  /** Approval-gated SMS to an Australian mobile. */
  smsAct(job: string, phone: string, text: string, key: string, summary: string) {
    const to = auMobile(phone);
    if (!to) throw new Error("servicem8: bad mobile number");
    return { platform: P, op: "messaging-api.send_sms", key, summary,
             input: { body: { to, message: text, regardingJobUUID: uuid(job) } } };
  },
};
