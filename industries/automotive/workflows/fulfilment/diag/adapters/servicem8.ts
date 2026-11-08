// ServiceM8: a diagnostic job is a Job in Quote status. The technician's notes are Notes on the job, photos are
// Attachments on the job, and the write-up is filed back as an internal job Note. The customer email is queued only.
// Field names from ServiceM8's official spec (Job, Note, Attachment, CompanyContact, EmailMessage).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Contact, EMAIL, UUID, uuid, DRAFT_MARK } from "../types.ts";

const P = "servicem8";
const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** Jobs in the intake status that are not archived. The status value is checked against the spec's list before it goes into a filter. */
const STATUSES = ["Quote", "Work Order", "Unsuccessful", "Completed"];
export async function openJobs(ctx: Ctx<Settings>) {
  const status = ctx.settings.intake_status ?? "Quote";
  if (!STATUSES.includes(status)) throw new Error(`servicem8: intake_status must be one of ${STATUSES.join(", ")}`);
  return (await list<any>(ctx, "servicem8-api.listJobs", `status eq '${status}'`))
    .filter((j) => j.active !== 0 && UUID.test(String(j.uuid ?? "")))
    .slice(0, 50);
}

export async function contactFor(ctx: Ctx<Settings>, companyUuid?: string): Promise<Contact> {
  if (!companyUuid || !UUID.test(companyUuid)) return {};
  const cs = await list<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${companyUuid}'`);
  const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
  return { name: [c.first, c.last].filter(Boolean).join(" ").slice(0, 120) || undefined,
           email: EMAIL.test(String(c.email ?? "")) ? String(c.email) : undefined };
}

/** The technician's own notes on the job, minus any write-up this workflow already filed. */
export async function techNotes(ctx: Ctx<Settings>, job: string): Promise<{ uuid: string; text: string }[]> {
  const notes = await list<any>(ctx, "servicem8-api.listNotes", `related_object_uuid eq '${uuid(job)}'`);
  return notes
    .filter((n) => n.active !== 0 && n.related_object === "job" && UUID.test(String(n.uuid ?? "")))
    .map((n) => ({ uuid: n.uuid as string, text: String(n.note ?? "").trim().slice(0, 4000) }))
    .filter((n) => n.text && !n.text.startsWith(DRAFT_MARK));
}

/** Photos on the job, counted and named. Names are data from the shop's files, only ever shown as text. */
export async function photosOn(ctx: Ctx<Settings>, job: string): Promise<string[]> {
  const types = (ctx.settings.servicem8?.photo_types ?? [".jpg", ".jpeg", ".png", ".heic"]).map((t) => t.toLowerCase());
  return (await list<any>(ctx, "servicem8-api.listAttachments", `related_object_uuid eq '${uuid(job)}'`))
    .filter((a) => a.active !== 0 && types.includes(String(a.file_type ?? "").toLowerCase()))
    .map((a) => String(a.attachment_name ?? "photo").slice(0, 120));
}

/** File the write-up on the job as an internal note. Returns the note uuid the platform gave back. */
export async function fileNote(ctx: Ctx<Settings>, job: string, text: string): Promise<string> {
  const r = await ctx.draft({ platform: P, op: "servicem8-api.createNotes", summary: `write-up note on job ${job}`,
    input: { body: { related_object: "job", related_object_uuid: uuid(job), note: text.slice(0, 4000) } } });
  return uuid(r.headers.get("x-record-uuid"));
}

/** The current text of a note the workflow filed. */
export async function readNote(ctx: Ctx<Settings>, noteUuid: string): Promise<string> {
  const r = await ctx.draft<any>({ platform: P, op: "servicem8-api.getNotes", summary: `read note ${noteUuid}`, input: { params: { uuid: uuid(noteUuid) } } });
  return String(r.data?.note ?? "").trim().slice(0, 8000);
}

/** Queue the write-up email. The approver sees the recipient and the subject; the send happens only on approval. */
export async function queueEmail(ctx: Ctx<Settings>, job: string, to: string, subject: string, htmlBody: string, key: string) {
  return ctx.queue({ platform: P, op: "messaging-api.send_email", key: `send:${key}`, summary: `Email write-up to ${to} for job ${job}`,
    input: { body: { to, subject, htmlBody, regardingJobUUID: uuid(job) } } });
}
