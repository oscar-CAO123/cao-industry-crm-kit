// ServiceM8: the one platform in the kit with mapped operations for this job. Field names come from ServiceM8's official
// spec: Job (uuid, status, active, completion_date, job_address, job_description), JobContact (job_uuid, first, last,
// email, mobile, is_primary_contact, active), SMSRecord (uuid, related_object_uuid, direction, message, timestamp).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Contact, type Reply, EMAIL, PHONE, text } from "../types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const uuid = (v: unknown): string | undefined => (UUID.test(String(v ?? "")) ? String(v) : undefined);

const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: "servicem8", op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** Australian mobiles are stored as 04xx xxx xxx; SMS needs +614xxxxxxxx. */
export function auMobile(v: unknown): string | undefined {
  const d = String(v ?? "").replace(/[\s()-]/g, "");
  const e164 = /^04\d{8}$/.test(d) ? `+61${d.slice(1)}` : d;
  return PHONE.test(e164) ? e164 : undefined;
}

interface JobRow { uuid?: string; status?: string; active?: number; completion_date?: string; job_address?: string; job_description?: string }
interface ContactRow { job_uuid?: string; first?: string; last?: string; email?: string; mobile?: string; is_primary_contact?: string; active?: number }
interface SmsRow { uuid?: string; related_object_uuid?: string; timestamp?: string; direction?: string; message?: string }

export interface CompletedJob { uuid: string; completed: string; address: string; description: string }

/** Completed jobs with a completion date. One page of ServiceM8's list is read per run. */
export async function completedJobs(ctx: Ctx<Settings>): Promise<CompletedJob[]> {
  return (await list<JobRow>(ctx, "servicem8-api.listJobs", "status eq 'Completed'"))
    .filter((j) => j.active !== 0 && uuid(j.uuid) && YMD.test(String(j.completion_date ?? "").slice(0, 10)))
    .map((j) => ({ uuid: uuid(j.uuid)!, completed: String(j.completion_date).slice(0, 10),
                   address: text(j.job_address, 200), description: text(j.job_description, 200) }));
}

/** The job's primary contact, with a mobile in +61 form and an email only when it is well formed. */
export async function contactOf(ctx: Ctx<Settings>, jobUuid: string): Promise<Contact> {
  const id = uuid(jobUuid);
  if (!id) return {};
  const rows = (await list<ContactRow>(ctx, "servicem8-api.listJobContacts", `job_uuid eq '${id}'`)).filter((x) => x.job_uuid === id && x.active !== 0);
  const c = rows.find((x) => x.is_primary_contact === "1") ?? rows[0] ?? {};
  const name = [c.first, c.last].filter(Boolean).join(" ");
  return { name: name ? text(name, 120) : undefined, email: EMAIL.test(c.email ?? "") ? c.email : undefined, phone: auMobile(c.mobile) };
}

/** Inbound text messages on one job. Outbound ones are ours and are not read back. */
export async function inboundSms(ctx: Ctx<Settings>, jobUuid: string): Promise<Reply[]> {
  const id = uuid(jobUuid);
  if (!id) return [];
  return (await list<SmsRow>(ctx, "servicem8-api.listSMSMessages", `related_object_uuid eq '${id}'`))
    .filter((m) => m.direction === "inbound" && m.related_object_uuid === id && uuid(m.uuid))
    .map((m) => ({ uuid: uuid(m.uuid)!, at: String(m.timestamp ?? ""), text: text(m.message, 500) }));
}
