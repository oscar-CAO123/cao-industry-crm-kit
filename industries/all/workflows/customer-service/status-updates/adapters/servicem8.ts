// ServiceM8 for the status-updates workflow: read active jobs and the client's contact, queue one status text or email.
// Field names come from ServiceM8's official spec (Job, CompanyContact, SMSMessage, EmailMessage).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Channel, type Contact, type Job, type Settings, EMAIL, PHONE, STATUSES, UUID, esc } from "../types.ts";

const P = "servicem8";
const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** Active jobs with a known status. Read only: the crons never write to a job. */
export async function activeJobs(ctx: Ctx<Settings>): Promise<Job[]> {
  const rows = await list<any>(ctx, "servicem8-api.listJobs", "active eq 1");
  return rows
    .filter((r) => UUID.test(String(r.uuid)) && STATUSES.includes(r.status))
    .slice(0, 500)
    .map((r): Job => ({
      uuid: String(r.uuid), status: r.status, job_address: String(r.job_address ?? "").slice(0, 200),
      company_uuid: UUID.test(String(r.company_uuid ?? "")) ? String(r.company_uuid) : undefined,
      work_order_date: r.work_order_date ? String(r.work_order_date) : undefined,
    }));
}

/** Australian mobiles are stored as 04xx xxx xxx; SMS needs +614xxxxxxxx. */
function auMobile(v: unknown): string | undefined {
  const d = String(v ?? "").replace(/[\s()-]/g, "");
  const e164 = /^04\d{8}$/.test(d) ? `+61${d.slice(1)}` : d;
  return PHONE.test(e164) ? e164 : undefined;
}

/** The primary contact of a client. The UUID is checked before it goes into the filter. */
export async function contactFor(ctx: Ctx<Settings>, companyUuid?: string): Promise<Contact> {
  if (!companyUuid || !UUID.test(companyUuid)) return {};
  const cs = await list<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${companyUuid}'`);
  const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
  const name = [c.first, c.last].filter(Boolean).join(" ").slice(0, 60);
  return { name: name || undefined, email: EMAIL.test(String(c.email ?? "")) ? String(c.email) : undefined, phone: auMobile(c.mobile) };
}

/** Which route a message takes: the preferred channel when the client has it, otherwise the other one. */
export function routeFor(channel: Channel, c: Contact): Channel | undefined {
  if (channel === "sms") return c.phone ? "sms" : c.email ? "email" : undefined;
  return c.email ? "email" : c.phone ? "sms" : undefined;
}

/** Queue one status message for approval. A queued key that already exists returns its approval id, so re-runs never double-queue. */
export function queueStatusMessage(ctx: Ctx<Settings>, key: string, job: Job, to: Channel, c: Contact, text: string) {
  const who = (c.name ?? "there").slice(0, 60);
  const business = ctx.settings.business_name ?? "the team";
  if (to === "sms") {
    return ctx.queue({ platform: P, op: "messaging-api.send_sms", key, summary: `status text to ${c.phone} (${job.status})`,
      input: { body: { to: c.phone, message: `Hi ${who}, ${text} Thanks, ${business}.`, regardingJobUUID: job.uuid } } });
  }
  return ctx.queue({ platform: P, op: "messaging-api.send_email", key, summary: `status email to ${c.email} (${job.status})`,
    input: { body: { to: c.email, subject: "Update on your job", htmlBody: `<p>Hi ${esc(who)}, ${esc(text)}</p><p>Thanks, ${esc(business)}</p>`, regardingJobUUID: job.uuid } } });
}

