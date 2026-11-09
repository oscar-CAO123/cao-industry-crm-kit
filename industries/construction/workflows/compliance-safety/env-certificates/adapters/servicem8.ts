// ServiceM8 for the paperwork workflow: read jobs, attachments and the customer contact; queue a chase email for approval.
// Field names from ServiceM8's official spec (Job: uuid, status, active, job_description, job_address, work_done_description,
// company_uuid; Attachment: attachment_name, file_type, related_object_uuid; CompanyContact: first, last, email, is_primary_contact).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Tracked, UUID, EMAIL, esc } from "../types.ts";

const P = "servicem8";
const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string): Promise<T[]> =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** Active jobs with a valid uuid, capped so one run stays small. */
export async function activeJobs(ctx: Ctx<Settings>): Promise<any[]> {
  return (await list<any>(ctx, "servicem8-api.listJobs", "active eq 1")).filter((j) => UUID.test(String(j.uuid ?? ""))).slice(0, 200);
}

/** The attachments filed against one job. */
export async function attachments(ctx: Ctx<Settings>, job: string): Promise<any[]> {
  if (!UUID.test(job)) throw new Error("servicem8: bad job uuid");
  return list<any>(ctx, "servicem8-api.listAttachments", `related_object_uuid eq '${job}'`);
}

/** The primary contact of a job's company, with an email only when it is well formed. */
export async function contact(ctx: Ctx<Settings>, company?: string): Promise<{ name?: string; email?: string }> {
  if (!company || !UUID.test(company)) return {};
  const cs = await list<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${company}'`);
  const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
  return { name: [c.first, c.last].filter(Boolean).join(" ") || undefined, email: EMAIL.test(c.email ?? "") ? String(c.email) : undefined };
}

/** Queue one chase email for approval. Nothing is sent here. */
export function queueChase(ctx: Ctx<Settings>, t: Tracked, n: number, to: string, text: string): Promise<string> {
  return ctx.queue({ platform: P, op: "messaging-api.send_email", key: `chase:${t.uuid}:${n}`, summary: `Chase ${t.missing.join(", ")} from ${to} for ${t.title}`,
    input: { body: { to, subject: `Paperwork for ${t.title}`, htmlBody: `<p>${esc(text)}</p>`, regardingJobUUID: t.uuid } } });
}
