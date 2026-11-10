// The quote-build ServiceM8 quote step. The construction quoting adapter is imported and not edited: its enquiry, rate card,
// refresh and follow-up steps are reused unchanged. Only draftQuote is copied here, with two changes:
//   1. Lines are written only when missing (same position and name already on the job means done). After the writes the job's
//      lines are read back, and the send is not queued unless every quote line is on the job, so a retry that failed part-way
//      cannot leave the job short of the quote total.
//   2. The stored job id is checked as a UUID before it goes into any OData filter.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { servicem8 as quotingServiceM8 } from "../../../../../../industries/construction/workflows/sales/quoting/adapters/servicem8.ts";
import type { Settings as QuotingSettings } from "../../../../../../industries/construction/workflows/sales/quoting/types.ts";
import { type Adapter, type Enquiry, type Line, type Quote, keyOf, total, quoteHtml, sendSummary } from "../types.ts";

const P = "servicem8";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("servicem8: bad uuid"); return s; };
/** An OData filter on a job id. The id is checked first, so nothing from the store can change the filter text. */
const onJob = (field: string, job: string) => `${field} eq '${uuid(job)}'`;
const list = async <T>(ctx: Ctx<QuotingSettings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];
/** A line is on the job when a row has its position and its name. */
const lineKey = (position: unknown, name: unknown) => `${String(position)}|${String(name)}`;
const jobLineKeys = async (ctx: Ctx<QuotingSettings>, job: string) =>
  new Set((await list<any>(ctx, "servicem8-api.listJobMaterials", onJob("job_uuid", job))).map((x) => lineKey(x.sort_order, x.name)));

async function draftQuote(ctx: Ctx<QuotingSettings>, e: Enquiry, lines: Line[]): Promise<Quote> {
  // A stored job id goes into OData filters and document requests below, so it is checked like every other id.
  let job = e.ref?.job_uuid ? uuid(e.ref.job_uuid) : undefined;
  if (!job) {
    const r = await ctx.draft({ platform: P, op: "servicem8-api.createJobs", summary: `create quote job for ${e.title}`,
      input: { body: { status: "Quote", job_description: `${e.title}\n${e.text ?? ""}`.slice(0, 4000), job_address: e.ref?.address ?? "" } } });
    job = uuid(r.headers.get("x-record-uuid"));
    // Remember the job at once: if a later step fails, the next run reuses it instead of creating another.
    await ctx.store.put("enquiries", e.id, { ...e, ref: { ...(e.ref ?? {}), job_uuid: job } });
  }
  // Only the lines not yet on the job are written. Then the job is read back: a quote line still missing stops the send.
  const numbered = lines.map((l, i) => ({ l, position: i + 1 }));
  const have = await jobLineKeys(ctx, job);
  for (const { l, position } of numbered.filter(({ l, position }) => !have.has(lineKey(position, l.name)))) {
    await ctx.draft({ platform: P, op: "servicem8-api.createJobMaterials", summary: `line ${l.code} x${l.qty}`,
      input: { body: { job_uuid: job, ...(l.ref?.material_uuid ? { material_uuid: l.ref.material_uuid } : {}), name: l.name, quantity: String(l.qty), price: String(l.unitPrice), sort_order: String(position) } } });
  }
  const after = await jobLineKeys(ctx, job);
  const short = numbered.filter(({ l, position }) => !after.has(lineKey(position, l.name)));
  if (short.length) throw new Error(`quote-build: ${short.length} quote line(s) are not on job ${job} after writing, so the send is not queued`);
  // The business's own quote template, filed to the job diary. The email carries exactly the PDF this run filed:
  // the one attachment that was not on the job before.
  const isPdf = (a: any) => /pdf/i.test(String(a.file_type ?? a.attachment_name ?? "")) && UUID.test(a.uuid);
  const before = new Set((await list<any>(ctx, "servicem8-api.listAttachments", onJob("related_object_uuid", job))).filter(isPdf).map((a) => a.uuid));
  await ctx.draft({ platform: P, op: "document-templates-api.produce_templated_document", summary: "quote PDF to job diary",
    input: { binary: true, body: { objectType: "Job", objectUUID: job, templateType: "Quote", outputFormat: "pdf", storeToDiary: true,
      ...(ctx.settings.servicem8?.quote_template_uuid ? { templateUUID: uuid(ctx.settings.servicem8.quote_template_uuid) } : {}) } } });
  const fresh = (await list<any>(ctx, "servicem8-api.listAttachments", onJob("related_object_uuid", job))).filter((a) => isPdf(a) && !before.has(a.uuid));
  const pdf = fresh.length === 1 ? fresh[0] : undefined;
  if (!pdf) ctx.log(`quote PDF for ${job} not found exactly once: the email goes without it; attach it in ServiceM8`);
  const q: Quote = { key: keyOf(`servicem8:${job}`), platform: P, enquiry: e.id, contact: e.contact, lines, total_ex_gst: total(lines), status: "draft",
                     ref: { job_uuid: job, ...(pdf?.uuid && UUID.test(pdf.uuid) ? { pdf_uuid: pdf.uuid } : {}) }, created: ctx.now.toISOString() };
  if (e.contact.email) {
    await ctx.queue({ platform: P, op: "messaging-api.send_email", key: `send:${q.key}`, summary: sendSummary(`Email quote for ${e.title}`, e.contact.email, q, (e as any).priced_by_proposal),
      input: { body: { to: e.contact.email, subject: `Your quote from ${ctx.settings.business_name ?? "us"}`,
        htmlBody: quoteHtml(ctx.settings, q, `Hi ${e.contact.name ?? "there"}, here is your quote for ${e.title}.`),
        regardingJobUUID: job, ...(q.ref.pdf_uuid ? { attachments: [q.ref.pdf_uuid] } : {}) } } });
  } else ctx.log(`no client email on ${job}: quote drafted, send it from ServiceM8`);
  return q;
}

/** The ServiceM8 quote step quote-build uses: the construction steps as they are, with this file's draftQuote. */
export const servicem8Quote: Adapter = { ...quotingServiceM8, draftQuote };
