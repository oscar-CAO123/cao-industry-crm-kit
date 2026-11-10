// ServiceM8 for the breakdown fix finder. Field names come from ServiceM8's official spec (Job, Note, NoteCreate,
// Material, JobMaterial, messaging send_email). Reads and the internal note are drafts; the email is only ever queued.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, UUID, esc } from "../types.ts";

export const P = "servicem8";
export const uuid = (v: unknown) => { const s = String(v ?? ""); if (!UUID.test(s)) throw new Error("servicem8: bad uuid"); return s; };

export const list = async <T>(ctx: Ctx<Settings>, op: string, filter?: string) =>
  ((await ctx.draft<T[]>({ platform: P, op, input: filter ? { params: { $filter: filter } } : {}, summary: `read ${op}` })).data ?? []) as T[];

/** Earlier jobs for the same customer, each with its notes. Reads only; at most five jobs. */
export async function priorNotes(ctx: Ctx<Settings>, company: string, current: string): Promise<string[]> {
  const jobs = (await list<any>(ctx, "servicem8-api.listJobs", `company_uuid eq '${uuid(company)}'`))
    .filter((j) => UUID.test(String(j.uuid ?? "")) && j.uuid !== current && j.active !== 0).slice(0, 5);
  const out: string[] = [];
  for (const j of jobs) {
    const notes = await list<any>(ctx, "servicem8-api.listNotes", `related_object_uuid eq '${uuid(j.uuid)}'`);
    const text = notes.map((n) => String(n.note ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 2).join(" / ");
    out.push(`${String(j.job_description ?? "earlier job").slice(0, 120)} (${String(j.status ?? "")})${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
  return out;
}

/** Parts on the stock list with stock on hand. */
export async function partsOnHand(ctx: Ctx<Settings>): Promise<string[]> {
  return (await list<any>(ctx, "servicem8-api.listMaterials", "active eq 1"))
    .filter((m) => Number(m.quantity_in_stock) > 0 && m.name)
    .slice(0, 30)
    .map((m) => `${String(m.name).slice(0, 80)} (${Number(m.quantity_in_stock)} in stock)`);
}

/** An internal note on a job. A draft: it reaches nobody outside the business. */
export function noteOn(ctx: Ctx<Settings>, job: string, text: string, summary: string) {
  return ctx.draft({ platform: P, op: "servicem8-api.createNotes", summary,
    input: { body: { related_object: "job", related_object_uuid: uuid(job), note: text.slice(0, 4000) } } });
}

/** The escalation email, as an act for the approval queue. It is never sent by a cron. */
export function escalationAct(job: string, key: string, to: string, subject: string, bodyText: string, summary: string) {
  return { platform: P, op: "messaging-api.send_email", key, summary,
    input: { body: { to, subject, htmlBody: `<p>${esc(bodyText)}</p>`, regardingJobUUID: uuid(job) } } };
}
