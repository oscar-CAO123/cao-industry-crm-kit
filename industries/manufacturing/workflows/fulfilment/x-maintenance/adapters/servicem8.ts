// ServiceM8 as the maintenance work-order system: a work order is a Job in "Work Order" status, a machine is an Asset
// (matched by name in the job text), the lockout steps are the job's checklist. Field names come from ServiceM8's
// official spec (Job, Asset, JobChecklistCreate, JobMaterial, CompanyContact, and the email operation used in quoting).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Asset, type Contact, type Request, SECTION, EMAIL, esc, statusName } from "../types.ts";

const P = "servicem8";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("servicem8: bad uuid"); return s; };
const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

async function contactFor(ctx: Ctx<Settings>, companyUuid?: string): Promise<Contact> {
  if (!companyUuid || !UUID.test(companyUuid)) return {};
  const cs = await list<any>(ctx, "servicem8-api.listCompanyContacts", `company_uuid eq '${companyUuid}'`);
  const c = cs.find((x) => x.is_primary_contact === "1") ?? cs[0] ?? {};
  return { name: [c.first, c.last].filter(Boolean).join(" ") || undefined, email: EMAIL.test(c.email ?? "") ? c.email : undefined };
}

export const servicem8: Adapter = {
  id: P,
  /** Open work orders, each matched to the machine (asset) whose name appears in the job text. */
  async openJobs(ctx) {
    const status = statusName(ctx.settings.job_status_open ?? "Work Order");
    const jobs = (await list<any>(ctx, "servicem8-api.listJobs", `status eq '${status}'`))
      .filter((j) => j.active !== 0 && UUID.test(String(j.uuid))).slice(0, 50);
    const assets = (await list<any>(ctx, "servicem8-api.listAssets"))
      .filter((a) => a.active !== 0 && UUID.test(String(a.uuid)) && String(a.name ?? "").trim().length >= 3)
      .map((a): Asset => ({ uuid: a.uuid, name: String(a.name), asset_code: a.asset_code ? String(a.asset_code) : undefined }));
    const out: Omit<Request, "status">[] = [];
    for (const j of jobs) {
      const text = String(j.job_description ?? "");
      const asset = assets.find((a) => text.toLowerCase().includes(a.name.toLowerCase()));
      out.push({ id: `servicem8:${j.uuid}`, job_uuid: j.uuid, title: text.slice(0, 120) || "Maintenance request", text: text.slice(0, 4000),
                 asset: asset?.name.slice(0, 120), contact: await contactFor(ctx, j.company_uuid), received: String(j.date ?? ctx.now.toISOString()) });
    }
    return out;
  },
};

/** Writes the lockout steps onto the work order's checklist. Steps already there are skipped, so a re-run adds nothing twice. */
export async function lockoutChecklist(ctx: Ctx<Settings>, r: Request): Promise<number> {
  const job = uuid(r.job_uuid);
  const have = new Set((await list<any>(ctx, "servicem8-api.listJobChecklists", `job_uuid eq '${job}'`))
    .filter((c) => c.section_name === SECTION).map((c) => String(c.name)));
  let added = 0;
  for (const [i, s] of (ctx.settings.lockout_steps ?? []).entries()) {
    const name = String(s).slice(0, 200);
    if (!name || have.has(name)) continue;
    await ctx.draft({ platform: P, op: "servicem8-api.createJobChecklists", summary: `lockout step ${i + 1} on ${job}`,
      input: { body: { job_uuid: job, name, section_name: SECTION, sort_order: String(i + 1) } } });
    added++;
  }
  return added;
}

/** Completed jobs and the parts on each, read for the record. */
export async function completedJobs(ctx: Ctx<Settings>) {
  const status = statusName(ctx.settings.job_status_done ?? "Completed");
  const jobs = (await list<any>(ctx, "servicem8-api.listJobs", `status eq '${status}'`))
    .filter((j) => j.active !== 0 && UUID.test(String(j.uuid))).slice(0, 50);
  const out = [];
  for (const j of jobs) {
    const parts = (await list<any>(ctx, "servicem8-api.listJobMaterials", `job_uuid eq '${j.uuid}'`))
      .filter((m) => m.active !== 0).map((m) => ({ name: String(m.name ?? "").slice(0, 200), quantity: String(m.quantity ?? ""), price: String(m.price ?? "") }));
    out.push({ id: `servicem8:${j.uuid}`, job_uuid: j.uuid as string, title: String(j.job_description ?? "").slice(0, 120), closed: String(j.edit_date ?? ""), parts });
  }
  return out;
}

/** The booking note to the requester: HTML escaped, sent only after a person approves it. */
export function bookingEmail(ctx: Ctx<Settings>, r: Request, to: string) {
  const who = esc(r.contact.name ?? "there");
  return {
    to,
    subject: `Your maintenance request at ${ctx.settings.business_name ?? "our workshop"}`,
    htmlBody: `<p>Hi ${who},</p><p>We have your request: ${esc(r.title)}.${r.asset ? ` Machine: ${esc(r.asset)}.` : ""}</p>`
      + `<p>We will confirm the booking time shortly.</p>`,
    regardingJobUUID: uuid(r.job_uuid),
  };
}
