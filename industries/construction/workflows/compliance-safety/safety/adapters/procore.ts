// Procore for the safety workflow: incidents and site inspections only. The incident and checklist pages read for this build carry no pre-start, SWMS or toolbox talk
// records (Procore may hold some in other tools, not mapped here), so those stay on SiteBook. Field names come from Procore's own reference pages (developers.procore.com/reference/rest/
// v1/incidents and /checklists, read 11 Nov 2026): GET /rest/v1.0/projects/{project_id}/incidents returns id, title, status
// (open, closed), recordable, event_date, number, deleted_at; GET /rest/v1.0/projects/{project_id}/checklist/lists returns id,
// name, identifier, status (Open, In Review, Closed), due_at, deleted, deficient_item_count; POST .../checklist/lists/{id}/send_email
// takes { subject, body, distribution_ids }. Reads are draft operations. The inspection email reaches people outside the kit, so it is only queued.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

const P = "procore";
const OP = { incidents: "incidents.list-incidents", inspections: "checklists.list-checklists-inspections", show: "checklists.show-checklist-inspection", email: "checklists.send-checklist-inspection-email" };
export const MAX_PAGES = 20;
const PER_PAGE = 100;
const INCIDENT_PER_PAGE = 1000;   // the incident list page documents a maximum of 1000

const num = (v: unknown) => { const s = String(v ?? ""); if (!/^[1-9]\d{0,11}$/.test(s)) throw new Error("procore: bad id"); return Number(s); };
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

export interface Incident { id: string; title: string; open: boolean; recordable: boolean; event: string; number?: number }
export interface Inspection { id: string; name: string; identifier: string; status: string; open: boolean; due: number; deficient: number }

export function projects(ctx: Ctx<Settings>): { id: string; name: string }[] {
  const all = ctx.settings.procore?.projects ?? [];
  if (all.length > 100) throw new Error("procore: more than 100 projects in settings; split them across two workflows");
  return all.map((p) => ({ id: String(num(p.id)), name: clean(p.name, 200) }));
}

/** Every page until an empty one. A project past MAX_PAGES, a 200 that is not a list, or a row with no usable id is refused whole. */
async function readAll(ctx: Ctx<Settings>, op: string, project: string, what: string, extra: Record<string, unknown>): Promise<any[]> {
  const pid = num(project), out: any[] = [], ids = new Set<number>(), per = op === OP.incidents ? INCIDENT_PER_PAGE : PER_PAGE;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await ctx.draft<any[]>({ platform: P, op, summary: `${what} in project ${pid}, page ${page}`, input: { params: { project_id: pid, page, per_page: per, ...extra } } });
    if (!Array.isArray(r.data)) throw new Error(`procore: the ${what} list did not come back as a list`);
    if (r.data.length === 0) return out;
    for (const x of r.data) {
      if (!Number.isInteger(x?.id) || x.id <= 0) throw new Error(`procore: a ${what} row came back with no usable id; the list is refused whole`);
      if (!ids.has(x.id)) { ids.add(x.id); out.push(x); }
    }
  }
  throw new Error(`procore: the ${what} list for project ${pid} is longer than ${MAX_PAGES} pages; refused whole`);
}

export async function incidents(ctx: Ctx<Settings>, project: string): Promise<Incident[]> {
  const rows = await readAll(ctx, OP.incidents, project, "incident", { sort: "created_at" });
  return rows.filter((x) => !x.deleted_at).map((x) => ({
    id: String(x.id), title: clean(x.title, 160) || "Incident", open: String(x.status ?? "").toLowerCase() === "open",
    recordable: x.recordable === true, event: clean(x.event_date, 40), number: Number.isInteger(x.number) ? x.number : undefined }));
}

export async function inspections(ctx: Ctx<Settings>, project: string): Promise<Inspection[]> {
  const rows = await readAll(ctx, OP.inspections, project, "inspection", {});
  return rows.filter((x) => x.deleted !== true).map((x) => ({
    id: String(x.id), name: clean(x.name, 160) || "Inspection", identifier: clean(x.identifier, 40), status: clean(x.status, 20),
    open: ["open", "in review"].includes(String(x.status ?? "").trim().toLowerCase()),
    due: Date.parse(String(x.due_at ?? "")), deficient: Number.isInteger(x.deficient_item_count) ? x.deficient_item_count : 0 }));
}

/** Queue one email about an inspection for a person to approve. The key makes a repeat run queue nothing new. */
export async function queueInspectionEmail(ctx: Ctx<Settings>, a: { project: string; id: string; key: string; summary: string; subject: string; body: string; status: string; distribution_ids: number[] }): Promise<string> {
  return ctx.queue({ platform: P, op: OP.email, key: a.key, summary: a.summary,
    // Re-read the inspection just before the send: an approval given after it was closed in Procore is closed instead of sent.
    check: { platform: P, op: OP.show, input: { params: { id: num(a.id), project_id: num(a.project) } }, expect: [{ path: "status", equals: a.status }] },
    input: { params: { id: num(a.id), project_id: num(a.project) }, body: { subject: clean(a.subject, 200), body: clean(a.body, 2000), distribution_ids: a.distribution_ids.map(num) } } }, a.summary);
}
