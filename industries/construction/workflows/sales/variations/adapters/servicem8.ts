// ServiceM8: the variation on an accepted job. A variation is a job note that says the client has extra work; the priced
// lines go to the client by email for approval, and a note on the job records it. ServiceM8 keeps no variation record,
// so the priced lines live in the kit's store. Field names from ServiceM8's official spec (Job, Note, Material, CompanyContact)
// and the messaging spec (EmailMessage).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Enquiry, type Line, type RateItem, type Variation, type Contact, EMAIL, PHONE, total, keyOf, esc, money, sendSummary, variationHtml } from "../types.ts";

const P = "servicem8" as const;
const WORK_ORDER = "Work Order";                         // only accepted jobs take variations
const RECORD = "Variation record (kit):";                // the prefix of the note this workflow writes, so intake never reads it back
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("servicem8: bad uuid"); return s; };
const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** Australian mobiles are stored as 04xx xxx xxx; SMS needs +614xxxxxxxx. Kept for the contact record. */
function auMobile(v: unknown): string | undefined {
  const d = String(v ?? "").replace(/[\s()-]/g, "");
  const e164 = /^04\d{8}$/.test(d) ? `+61${d.slice(1)}` : d;
  return PHONE.test(e164) ? e164 : undefined;
}
async function contactFor(ctx: Ctx<Settings>, companyUuid?: string): Promise<Contact> {
  if (!companyUuid || !UUID.test(companyUuid)) return {};
  const cs = await list<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${companyUuid}'`);
  const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
  return { name: [c.first, c.last].filter(Boolean).join(" ") || undefined, email: EMAIL.test(c.email ?? "") ? c.email : undefined,
           phone: auMobile(c.mobile) };
}

export const servicem8 = {
  /** Notes on accepted jobs that say the client has extra work. A note this workflow wrote is never read back. */
  async notes(ctx: Ctx<Settings>): Promise<Omit<Enquiry, "status">[]> {
    const words = (ctx.settings.variation_words ?? ["variation", "extra work", "additional work", "change order"]).map((w) => w.toLowerCase());
    const jobs = (await list<any>(ctx, "servicem8-api.listJobs", `status eq '${WORK_ORDER}'`)).filter((j) => j.active !== 0 && UUID.test(String(j.uuid))).slice(0, 50);
    const out: Omit<Enquiry, "status">[] = [];
    for (const j of jobs) {
      const notes = await list<any>(ctx, "servicem8-api.listNotes", `related_object_uuid eq '${j.uuid}'`);
      for (const n of notes) {
        const text = String(n.note ?? "").slice(0, 4000);
        if (n.active === 0 || !UUID.test(String(n.uuid)) || text.startsWith(RECORD)) continue;
        if (!words.some((w) => text.toLowerCase().includes(w))) continue;
        out.push({ id: `servicem8:note:${n.uuid}`, source: P, title: `Variation on ${String(j.job_address ?? "a job").slice(0, 100)}`,
                   text, contact: await contactFor(ctx, j.company_uuid), received: String(n.create_date ?? ctx.now.toISOString()),
                   ref: { job_uuid: j.uuid, note_uuid: n.uuid, address: String(j.job_address ?? "").slice(0, 200) } });
      }
    }
    return out;
  },
  async rateCard(ctx: Ctx<Settings>): Promise<RateItem[]> {
    return (await list<any>(ctx, "servicem8-api.listMaterials", "active eq 1"))
      .filter((m) => UUID.test(String(m.uuid)) && Number.isFinite(Number(m.price)))
      .map((m): RateItem => ({ code: String(m.item_number || m.uuid), name: String(m.name ?? "").slice(0, 200), price: Number(m.price) }));
  },
  /** Write one internal note on the job, then queue the priced variation to the client for approval. */
  async draftVariation(ctx: Ctx<Settings>, e: Enquiry, lines: Line[], priced: boolean): Promise<Variation> {
    const job = uuid(e.ref?.job_uuid);
    let record = e.ref?.record_note;
    if (!record) {
      const r = await ctx.draft({ platform: P, op: "servicem8-api.createNotes", summary: `variation record note on job for ${e.title}`,
        input: { body: { related_object: "job", related_object_uuid: job, note: `${RECORD} ${lines.length} lines, ${money(total(lines))} ex GST, awaiting client approval` } } });
      record = uuid(r.headers.get("x-record-uuid"));
      // Remember the note at once: if a later step fails, the next run does not write a second one.
      await ctx.store.put("enquiries", e.id, { ...e, ref: { ...(e.ref ?? {}), record_note: record } });
    }
    const key = keyOf(`servicem8:${e.ref?.note_uuid ?? e.id}`);
    const v: Variation = { key, platform: P, enquiry: e.id, job, contact: e.contact, lines, total_ex_gst: total(lines), status: "draft",
                           ref: { job_uuid: job, note_uuid: String(e.ref?.note_uuid ?? ""), record_note: record }, created: ctx.now.toISOString() };
    if (e.contact.email) {
      const who = e.contact.name ?? "there";
      await ctx.queue({ platform: P, op: "messaging-api.send_email", key: `send:${key}`, summary: sendSummary(`Email variation for ${e.title}`, e.contact.email, v, priced),
        input: { body: { to: e.contact.email, subject: `Extra work for approval from ${ctx.settings.business_name ?? "us"}`,
          htmlBody: variationHtml(ctx.settings, v, `Hi ${who}, here is the extra work for ${e.title}. Please reply to approve it before we start.`),
          regardingJobUUID: job } } });
    } else ctx.log(`no client email on ${job}: variation drafted, send it from ServiceM8`);
    return v;
  },
  /** One follow-up email for a variation sent for approval. No email on the contact means nothing is queued. */
  async followUp(ctx: Ctx<Settings>, v: Variation, n: number): Promise<string | undefined> {
    if (!v.contact.email) return undefined;
    const text = `Hi ${v.contact.name ?? "there"}, following up on the extra work we sent. Happy to answer any questions.`;
    return ctx.queue({ platform: P, op: "messaging-api.send_email", key: `follow${n}:${v.key}`, summary: `follow-up ${n} email to ${v.contact.email}`,
      input: { body: { to: v.contact.email, subject: "Following up on the extra work", htmlBody: `<p>${esc(text)}</p>`, regardingJobUUID: v.job } } });
  },
};
