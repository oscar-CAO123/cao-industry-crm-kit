// ServiceM8: inspections run as jobs. A booked inspection is a Work Order; its inspector is a job allocation, and the visit
// is done when that allocation has a completion time. Staff notes and photos sit on the job. Field names from ServiceM8's
// official spec (Job, JobAllocation, Note, Attachment, CompanyContact, EmailMessage in messaging-api).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Inspection, UUID, uuid, EMAIL, IMAGE, esc } from "../types.ts";

const P = "servicem8";
type Rec = Record<string, any>;
const rows = async (ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<Rec[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as Rec[];

/** The primary contact on the job's company: the person the report goes to. */
async function contactFor(ctx: Ctx<Settings>, companyUuid?: string): Promise<Inspection["contact"]> {
  if (!companyUuid || !UUID.test(companyUuid)) return {};
  const cs = await rows(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${uuid(companyUuid)}'`);
  const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
  return { name: [c.first, c.last].filter(Boolean).join(" ") || undefined, email: EMAIL.test(c.email ?? "") ? String(c.email) : undefined };
}

/** Open inspection jobs (Work Order status whose description matches the inspection word), with allocation and visit state. */
export async function openInspections(ctx: Ctx<Settings>): Promise<Omit<Inspection, "status">[]> {
  const word = (ctx.settings.inspection_match ?? "inspection").toLowerCase();
  const jobs = (await rows(ctx, "servicem8-api.listJobs", "status eq 'Work Order'"))
    .filter((j) => j.active !== 0 && UUID.test(String(j.uuid)) && String(j.job_description ?? "").toLowerCase().includes(word))
    .slice(0, 50);
  const out: Omit<Inspection, "status">[] = [];
  for (const j of jobs) {
    const allocs = (await rows(ctx, "servicem8-api.listJobAllocations", `job_uuid eq '${uuid(j.uuid)}'`)).filter((a) => a.active !== 0);
    const done = allocs.find((a) => a.completion_timestamp);
    out.push({
      id: `servicem8:${j.uuid}`, job_uuid: String(j.uuid), title: String(j.job_description ?? "Inspection").slice(0, 120),
      address: String(j.job_address ?? "").slice(0, 200), contact: await contactFor(ctx, j.company_uuid),
      assigned: allocs.length > 0, visited: done ? String(done.completion_timestamp) : undefined,
    });
  }
  return out;
}

/** The staff notes and the image attachments on a job. Notes are data from inspectors: they are copied, never run. */
export async function findingsFor(ctx: Ctx<Settings>, job: string): Promise<{ notes: string[]; photos: string[] }> {
  const notes = (await rows(ctx, "servicem8-api.listNotes", `related_object_uuid eq '${uuid(job)}'`))
    .filter((n) => n.active !== 0 && String(n.note ?? "").trim())
    .map((n) => String(n.note).trim().slice(0, 1000));
  const photos = (await rows(ctx, "servicem8-api.listAttachments", `related_object_uuid eq '${uuid(job)}'`))
    .filter((a) => a.active !== 0 && IMAGE.test(String(a.file_type ?? a.attachment_name ?? "")) && UUID.test(String(a.uuid)))
    .map((a) => String(a.uuid));
  return { notes, photos };
}

/** One internal note on the job holding the draft. Nothing outside the business reads it. */
export async function draftNote(ctx: Ctx<Settings>, job: string, text: string): Promise<string> {
  const r = await ctx.draft({ platform: P, op: "servicem8-api.createNotes", summary: `draft findings note on ${job}`,
    input: { body: { related_object: "job", related_object_uuid: uuid(job), note: text.slice(0, 4000) } } });
  return uuid(r.headers.get("x-record-uuid") ?? (r.data as Rec)?.uuid);
}

/** The owner's report: the findings as escaped paragraphs. Used as an approval's email body, never sent by a cron. */
export function reportHtml(s: Settings, i: Inspection): string {
  const paras = (i.findings ?? "").split("\n").filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join("");
  return `<p>Hi ${esc(i.contact.name ?? "there")},</p><p>The inspection report for ${esc(i.address)} is ready.</p>${paras}`
    + `<p>${esc(s.business_name ?? "")}</p>`;
}
