// ServiceM8 for the defects workflow. A defect is an item in a job's defect checklist section; the register, the trade
// reminders and the client sign-off all run from that. Field names come from ServiceM8's official spec
// (Job, JobChecklist, Task, CompanyContact, EmailMessage). Reads and internal tasks are draft operations; email is live.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, UUID, EMAIL } from "../types.ts";

const P = "servicem8" as const;
const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("servicem8: bad uuid"); return s; };
const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** A timestamp ServiceM8 sets when an item is ticked. Empty values come back as zeros. */
const doneAt = (v: unknown) => { const s = String(v ?? ""); return /^\d{4}-\d{2}-\d{2}/.test(s) && !s.startsWith("0000") ? s : undefined; };

export const servicem8: Adapter = {
  id: P,
  /** Jobs in Work Order status: the ones whose defects are tracked. */
  async openJobs(ctx) {
    return (await list<any>(ctx, "servicem8-api.listJobs", "status eq 'Work Order'"))
      .filter((j) => j.active !== 0 && UUID.test(String(j.uuid)))
      .slice(0, 100)
      .map((j) => ({ uuid: String(j.uuid), address: String(j.job_address ?? "").slice(0, 200), company_uuid: UUID.test(String(j.company_uuid ?? "")) ? String(j.company_uuid) : undefined }));
  },
  /** Items in the defect section of one job, with whether each is ticked. */
  async defectItems(ctx, jobUuid) {
    const job = uuid(jobUuid), want = (ctx.settings.defect_section ?? "").trim().toLowerCase();
    if (!want) throw new Error("servicem8: set defect_section in settings");
    return (await list<any>(ctx, "servicem8-api.listJobChecklists", `job_uuid eq '${job}'`))
      .filter((c) => String(c.section_name ?? "").trim().toLowerCase() === want && UUID.test(String(c.uuid)))
      .map((c) => ({ uuid: String(c.uuid), name: String(c.name ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200), active: c.active !== 0, completed_at: doneAt(c.completed_timestamp) }));
  },
  /** One task on the job for staff. Internal only: nobody outside the business is told. */
  async createTask(ctx, jobUuid, title, details) {
    const r = await ctx.draft({ platform: P, op: "servicem8-api.createTasks", summary: `task on job ${jobUuid}: ${title}`,
      input: { body: { name: title.slice(0, 200), task_details: details.slice(0, 2000), related_object: "job", related_object_uuid: uuid(jobUuid) } } });
    const ref = r.headers.get("x-record-uuid");
    return ref && UUID.test(ref) ? ref : undefined;
  },
  /** The primary contact on the job's client company, when it has a usable email. */
  async clientContact(ctx, companyUuid) {
    if (!companyUuid || !UUID.test(companyUuid)) return {};
    const cs = await list<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${companyUuid}'`);
    const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
    return { name: [c.first, c.last].filter(Boolean).join(" ") || undefined, email: EMAIL.test(String(c.email ?? "")) ? String(c.email) : undefined };
  },
  /** Queue one email for a person to approve. The key makes a repeat run queue nothing new. */
  async queueEmail(ctx, a) {
    return ctx.queue({ platform: P, op: "messaging-api.send_email", key: a.key, summary: a.summary,
      input: { body: { to: a.to, subject: a.subject, htmlBody: a.html, regardingJobUUID: uuid(a.jobUuid) } } });
  },
};
