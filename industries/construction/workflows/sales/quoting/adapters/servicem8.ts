// ServiceM8: the service and minor-works quote. A quote is a Job in "Quote" status; its price is the job's materials;
// the PDF comes from the business's own Quote template; on online acceptance ServiceM8 moves the job to "Work Order".
// Field names from ServiceM8's official spec (Job, JobMaterial, EmailMessage, SMSMessage, platform_produce_document).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Enquiry, type Line, type Quote, type RateItem, EMAIL, PHONE, total, quoteHtml, keyOf, esc, sendSummary } from "../types.ts";

const P = "servicem8";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("servicem8: bad uuid"); return s; };
const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** Australian mobiles are stored as 04xx xxx xxx; SMS needs +614xxxxxxxx. */
function auMobile(v: unknown): string | undefined {
  const d = String(v ?? "").replace(/[\s()-]/g, "");
  const e164 = /^04\d{8}$/.test(d) ? `+61${d.slice(1)}` : d;
  return PHONE.test(e164) ? e164 : undefined;
}
async function contactFor(ctx: Ctx<Settings>, companyUuid?: string) {
  if (!companyUuid || !UUID.test(companyUuid)) return {};
  const cs = await list<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${companyUuid}'`);
  const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
  return { name: [c.first, c.last].filter(Boolean).join(" ") || undefined, email: EMAIL.test(c.email ?? "") ? c.email : undefined,
           phone: auMobile(c.mobile) };
}

export const servicem8: Adapter = {
  id: P,
  /** Jobs in Quote status that have no priced lines yet. */
  async enquiries(ctx) {
    const jobs = (await list<any>(ctx, "servicem8-api.listJobs", "status eq 'Quote'")).filter((j) => j.active !== 0 && UUID.test(j.uuid)).slice(0, 50);
    const out = [];
    for (const j of jobs) {
      const lines = await list<any>(ctx, "servicem8-api.listJobMaterials", `job_uuid eq '${j.uuid}'`);
      if (lines.length) continue;
      out.push({ id: `servicem8:${j.uuid}`, source: P as const, title: String(j.job_description ?? "Quote request").slice(0, 120),
                 text: String(j.job_description ?? "").slice(0, 4000), contact: await contactFor(ctx, j.company_uuid),
                 received: String(j.date ?? ctx.now.toISOString()), ref: { job_uuid: j.uuid, address: String(j.job_address ?? "").slice(0, 200) } });
    }
    return out;
  },
  async rateCard(ctx) {
    return (await list<any>(ctx, "servicem8-api.listMaterials", "active eq 1"))
      .filter((m) => UUID.test(m.uuid) && Number.isFinite(Number(m.price)))
      .map((m): RateItem => ({ code: String(m.item_number || m.uuid), name: String(m.name ?? ""), price: Number(m.price), ref: { material_uuid: m.uuid } }));
  },
  async draftQuote(ctx, e: Enquiry, lines: Line[]) {
    let job = e.ref?.job_uuid;
    if (!job) {
      const r = await ctx.draft({ platform: P, op: "servicem8-api.createJobs", summary: `create quote job for ${e.title}`,
        input: { body: { status: "Quote", job_description: `${e.title}\n${e.text ?? ""}`.slice(0, 4000), job_address: e.ref?.address ?? "" } } });
      job = uuid(r.headers.get("x-record-uuid"));
      // Remember the job at once: if a later step fails, the next run reuses it instead of creating another.
      await ctx.store.put("enquiries", e.id, { ...e, ref: { ...(e.ref ?? {}), job_uuid: job } });
    }
    const existing = await list<any>(ctx, "servicem8-api.listJobMaterials", `job_uuid eq '${job}'`);
    for (const [i, l] of (existing.length ? [] : lines).entries()) {
      await ctx.draft({ platform: P, op: "servicem8-api.createJobMaterials", summary: `line ${l.code} x${l.qty}`,
        input: { body: { job_uuid: job, ...(l.ref?.material_uuid ? { material_uuid: l.ref.material_uuid } : {}), name: l.name, quantity: String(l.qty), price: String(l.unitPrice), sort_order: String(i + 1) } } });
    }
    // The business's own quote template, filed to the job diary. The email carries exactly the PDF this run filed:
    // the one attachment that was not on the job before.
    const isPdf = (a: any) => /pdf/i.test(String(a.file_type ?? a.attachment_name ?? "")) && UUID.test(a.uuid);
    const before = new Set((await list<any>(ctx, "servicem8-api.listAttachments", `related_object_uuid eq '${job}'`)).filter(isPdf).map((a) => a.uuid));
    await ctx.draft({ platform: P, op: "document-templates-api.produce_templated_document", summary: "quote PDF to job diary",
      input: { binary: true, body: { objectType: "Job", objectUUID: job, templateType: "Quote", outputFormat: "pdf", storeToDiary: true,
        ...(ctx.settings.servicem8?.quote_template_uuid ? { templateUUID: uuid(ctx.settings.servicem8.quote_template_uuid) } : {}) } } });
    const fresh = (await list<any>(ctx, "servicem8-api.listAttachments", `related_object_uuid eq '${job}'`)).filter((a) => isPdf(a) && !before.has(a.uuid));
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
  },
  /** ServiceM8 moves an accepted quote to Work Order, and a lost one to Unsuccessful. */
  async refresh(ctx, quotes) {
    for (const q of quotes) {
      const [j] = await list<any>(ctx, "servicem8-api.listJobs", `uuid eq '${uuid(q.ref.job_uuid)}'`);
      if (j?.status === "Work Order" || j?.status === "Completed") { if (q.status !== "accepted") { q.status = "accepted"; q.accepted_at = ctx.now.toISOString(); } }
      else if (j?.status === "Unsuccessful") q.status = "declined";
    }
    return quotes;
  },
  async followUp(ctx, q, n) {
    const sms = ctx.settings.follow_up?.channel === "sms" && q.contact.phone;
    const text = `Hi ${q.contact.name ?? "there"}, just checking you received our quote. Happy to answer any questions.`;
    return ctx.queue(sms
      ? { platform: P, op: "messaging-api.send_sms", key: `follow${n}:${q.key}`, summary: `follow-up ${n} SMS to ${q.contact.phone}`,
          input: { body: { to: q.contact.phone, message: text, regardingJobUUID: q.ref.job_uuid } } }
      : { platform: P, op: "messaging-api.send_email", key: `follow${n}:${q.key}`, summary: `follow-up ${n} email to ${q.contact.email}`,
          input: { body: { to: q.contact.email, subject: `Following up on your quote`, htmlBody: `<p>${esc(text)}</p>`, regardingJobUUID: q.ref.job_uuid,
                           ...(q.ref.pdf_uuid ? { attachments: [q.ref.pdf_uuid] } : {}) } } });
  },
};
