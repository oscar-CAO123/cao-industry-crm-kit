// ServiceM8: the field-crew schedule. A crew allocation is a JobAllocation (one job, one staff member, one day);
// a staff note is a StaffMessage to that person; the client text is an SMS that only ever waits for approval.
// Field names from ServiceM8's official spec (Job, JobAllocation, JobAllocationCreate, StaffMessageCreate, Staff, CompanyContact, SMSMessage).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Job, type Allocation, DAY, keyOf } from "../types.ts";

export const P = "servicem8" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^\+[1-9]\d{6,14}$/;

export const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("servicem8: bad uuid"); return s; };
const isActive = (r: any) => Number(r?.active) !== 0;
async function rows<T>(ctx: Ctx<Settings>, op: string, filter?: string): Promise<T[]> {
  const r = await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` });
  return (r.data ?? []) as T[];
}

/** Australian mobiles are stored as 04xx xxx xxx; SMS needs +614xxxxxxxx. */
export function auMobile(v: unknown): string | undefined {
  const d = String(v ?? "").replace(/[\s()-]/g, "");
  const e164 = /^04\d{8}$/.test(d) ? `+61${d.slice(1)}` : d;
  return PHONE.test(e164) ? e164 : undefined;
}

/** Work Order jobs with no crew allocation yet (the office may have allocated one by hand). */
export async function openJobs(ctx: Ctx<Settings>): Promise<Omit<Job, "status">[]> {
  const jobs = (await rows<any>(ctx, "servicem8-api.listJobs", "status eq 'Work Order'"))
    .filter((j) => isActive(j) && UUID.test(String(j.uuid ?? ""))).slice(0, 50);
  const out: Omit<Job, "status">[] = [];
  for (const j of jobs) {
    if ((await allocationsForJob(ctx, j.uuid)).length) continue;
    out.push({ id: `servicem8:${j.uuid}`, uuid: j.uuid, title: String(j.job_description ?? "Job").slice(0, 80),
               company_uuid: UUID.test(String(j.company_uuid ?? "")) ? j.company_uuid : undefined, received: String(j.date ?? ctx.now.toISOString()) });
  }
  return out;
}

export async function allocationsForJob(ctx: Ctx<Settings>, job: string): Promise<any[]> {
  return (await rows<any>(ctx, "servicem8-api.listJobAllocations", `job_uuid eq '${uuid(job)}'`)).filter(isActive);
}

/** Allocations on one day. The date is checked on our side too, in case the platform returns a timestamp. */
export async function allocationsOn(ctx: Ctx<Settings>, date: string): Promise<any[]> {
  if (!DATE.test(date)) throw new Error("servicem8: bad date");
  return (await rows<any>(ctx, "servicem8-api.listJobAllocations", `allocation_date eq '${date}'`))
    .filter((a) => isActive(a) && String(a.allocation_date ?? "").slice(0, 10) === date);
}

/** The settings' crew, limited to staff ServiceM8 still lists as active. */
export async function activeCrew(ctx: Ctx<Settings>): Promise<string[]> {
  const live = new Set((await rows<any>(ctx, "servicem8-api.listStaffMembers", "active eq 1")).filter(isActive).map((s) => String(s.uuid)));
  return ctx.settings.crew.filter((u) => live.has(u));
}

export async function clientContact(ctx: Ctx<Settings>, companyUuid?: string): Promise<{ first?: string; mobile?: string }> {
  if (!companyUuid || !UUID.test(companyUuid)) return {};
  const cs = (await rows<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${uuid(companyUuid)}'`)).filter(isActive);
  const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
  return { first: String(c.first ?? "").trim() || undefined, mobile: auMobile(c.mobile) ?? auMobile(c.phone) };
}

/** Draft the allocation in ServiceM8. Returns the new allocation's id when the reply carries it. */
export async function draftAllocation(ctx: Ctx<Settings>, job: string, staff: string, date: string): Promise<string | undefined> {
  const s = ctx.settings;
  const r = await ctx.draft({ platform: P, op: "servicem8-api.createJobAllocations", summary: `allocate job ${job} to ${staff} on ${date}`,
    input: { body: { job_uuid: uuid(job), staff_uuid: uuid(staff), allocation_date: date,
      ...(s.allocation_window_uuid ? { allocation_window_uuid: uuid(s.allocation_window_uuid) } : {}),
      ...(s.office_staff_uuid ? { allocated_by_staff_uuid: uuid(s.office_staff_uuid) } : {}) } } });
  const id = r.headers.get("x-record-uuid");
  return id && UUID.test(id) ? id : undefined;
}

/** A note to the crew member, from the office. Internal: it reaches staff only. Skipped when no office user is set. */
export async function draftStaffNote(ctx: Ctx<Settings>, job: string, staff: string, label: string): Promise<void> {
  const from = ctx.settings.office_staff_uuid;
  if (!from) return;
  await ctx.draft({ platform: P, op: "servicem8-api.createStaffMessages", summary: `staff note to ${staff} for ${label}`,
    input: { body: { from_staff_uuid: uuid(from), to_staff_uuid: uuid(staff), regarding_job_uuid: uuid(job),
      message: `New job booked for ${label}. Open it in ServiceM8 for the address and details.` } } });
}

/** The client text. It is only ever queued: a person approves it in the CRM shell. */
export async function queueClientText(ctx: Ctx<Settings>, a: Allocation, to: string, text: string, label: string): Promise<string> {
  return ctx.queue({ platform: P, op: "messaging-api.send_sms", key: `notify:${keyOf(`servicem8:${a.job}`)}`,
    summary: `text ${to} that the visit is booked for ${label}`,
    input: { body: { to, message: text, regardingJobUUID: uuid(a.job) } } });
}

/** Days from now that a crew can take a job, in the business timezone, weekends left out unless allowed. */
export function candidateDays(now: Date, tz: string, horizon: number, weekends: boolean): string[] {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const dow = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short" });
  const out: string[] = [];
  for (let i = 0; i < horizon; i++) {
    const d = new Date(now.getTime() + i * DAY);
    if (!weekends && /^(Sat|Sun)/.test(dow.format(d))) continue;
    out.push(ymd.format(d));
  }
  return out;
}

export function dayLabel(date: string, tz: string): string {
  return new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "long", day: "numeric", month: "long" })
    .format(new Date(`${date}T12:00:00Z`));
}

export const clientText = (business: string, first: string | undefined, label: string) =>
  `Hi ${first ?? "there"}, your visit with ${business} is booked for ${label}.`;
