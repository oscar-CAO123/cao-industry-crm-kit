// ServiceM8: a job is the unit of tracking. Status moves Quote -> Work Order -> Completed (or Unsuccessful).
// Field names from ServiceM8's official spec (Job, NoteCreate, CompanyContact, EmailMessage, SMSMessage).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Contact, type Settings, type Tracked, EMAIL, PHONE, UUID, esc, keyOf, latest, ts } from "../types.ts";

const P = "servicem8" as const;

const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** Australian mobiles are stored as 04xx xxx xxx; SMS needs +614xxxxxxxx. */
function auMobile(v: unknown): string | undefined {
  const d = String(v ?? "").replace(/[\s()-]/g, "");
  const e164 = /^04\d{8}$/.test(d) ? `+61${d.slice(1)}` : d;
  return PHONE.test(e164) ? e164 : undefined;
}

async function contactFor(ctx: Ctx<Settings>, companyUuid?: string): Promise<Contact> {
  if (!companyUuid || !UUID.test(companyUuid)) return {};
  const cs = await list<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${companyUuid}'`);
  const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
  return {
    name: [c.first, c.last].filter(Boolean).join(" ") || undefined,
    email: EMAIL.test(c.email ?? "") ? c.email : undefined,
    phone: auMobile(c.mobile),
  };
}

export const servicem8: Adapter = {
  id: P,
  /** Jobs in Quote or Work Order that are still active. */
  async open(ctx) {
    const out: Omit<Tracked, "opened">[] = [];
    for (const status of ["Quote", "Work Order"]) {
      const jobs = (await list<any>(ctx, "servicem8-api.listJobs", `status eq '${status}'`))
        .filter((j) => j.active !== 0 && UUID.test(String(j.uuid)))
        .slice(0, 100);
      for (const j of jobs) {
        out.push({
          key: keyOf(`servicem8:${j.uuid}`),
          platform: P,
          ref: { job_uuid: String(j.uuid) },
          title: String(j.job_description ?? "Job").slice(0, 120),
          status: String(j.status),
          contact: await contactFor(ctx, j.company_uuid),
          last_activity: ts(j.edit_date),
        });
      }
    }
    return out;
  },
  async refresh(ctx, t) {
    const uuid = t.ref.job_uuid;
    if (!UUID.test(uuid)) throw new Error("servicem8: bad job uuid on the tracking record");
    const j = (await ctx.draft<any>({ platform: P, op: "servicem8-api.getJobs", input: { params: { uuid } }, summary: `read job ${uuid}` })).data;
    return { status: String(j?.status ?? t.status), last_activity: latest(t.last_activity, ts(j?.edit_date)) };
  },
  /** An internal job note: staff read it, the customer does not. */
  async note(ctx, t, text) {
    await ctx.draft({ platform: P, op: "servicem8-api.createNotes", summary: `internal note on job ${t.ref.job_uuid}`,
      input: { body: { related_object: "job", related_object_uuid: t.ref.job_uuid, note: text.slice(0, 2000) } } });
  },
  /** Queued only. An email or SMS to the customer, linked to the job so it shows in the job diary. */
  async clientMessage(ctx, t, subject, text, key) {
    const job = t.ref.job_uuid;
    if ((ctx.settings.servicem8?.client_channel ?? "email") === "sms" && t.contact.phone) {
      return ctx.queue({ platform: P, op: "messaging-api.send_sms", key, summary: `SMS about ${t.title} to ${t.contact.phone}`,
        input: { body: { to: t.contact.phone, message: text.replace(/[^\x20-\x7E]/g, "").slice(0, 1600), regardingJobUUID: job } } });
    }
    if (t.contact.email) {
      return ctx.queue({ platform: P, op: "messaging-api.send_email", key, summary: `Email "${subject}" to ${t.contact.email} about ${t.title}`,
        input: { body: { to: t.contact.email, subject: subject.slice(0, 200), htmlBody: `<p>${esc(text)}</p>`, regardingJobUUID: job } } });
    }
    ctx.log(`no client contact on job ${job}: no message queued`);
    return undefined;
  },
};
