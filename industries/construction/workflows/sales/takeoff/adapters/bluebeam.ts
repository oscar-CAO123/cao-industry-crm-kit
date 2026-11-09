// Bluebeam Studio for the tender reader: the plan PDFs in one project, a markup list job per plan, and its result.
// Every operation here reaches only the business's own project; nothing is shared, invited or published.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { PROJECT, type PlanFile, type Settings } from "../types.ts";

const P = "bluebeam";
const project = (ctx: Ctx<Settings>) => {
  const p = ctx.settings.bluebeam?.project_id;
  if (!p || !PROJECT.test(p)) throw new Error("bluebeam.project_id is not set or is not a project id");
  return p;
};
const whole = (n: unknown) => { const v = Number(n); if (!Number.isInteger(v) || v <= 0) throw new Error("bluebeam: bad file or job id"); return v; };

/** The PDF plan files in the project. */
export async function planFiles(ctx: Ctx<Settings>): Promise<PlanFile[]> {
  const r = await ctx.draft<any>({ platform: P, op: "ProjectFiles_GetAll", summary: "list project plan files", input: { params: { projectId: project(ctx), limit: 200 } } });
  return (r.data?.ProjectFiles ?? [])
    .filter((f: any) => Number.isInteger(f?.Id) && /\.pdf$/i.test(String(f?.Name ?? "")))
    .map((f: any): PlanFile => ({ Id: f.Id, Name: String(f.Name).slice(0, 200) }));
}

/** Start the job that lists every markup on one plan file. Returns the job id. */
export async function startMarkups(ctx: Ctx<Settings>, fileId: number): Promise<number> {
  const r = await ctx.draft<any>({ platform: P, op: "ProjectFileJobs_Post_MarkupList", summary: `start markup list for file ${fileId}`, input: {
    params: { projectId: project(ctx), fileId: whole(fileId) }, body: {} } });
  return whole(r.data?.Id);
}

/** The markups from a finished job, or undefined while the result carries none. An empty list counts as not yet
 *  finished (see gaps: the done status is not in the spec), so the cron keeps polling up to max_polls. */
export async function markups(ctx: Ctx<Settings>, fileId: number, jobId: number): Promise<any[] | undefined> {
  const r = await ctx.draft<any>({ platform: P, op: "ProjectFileJobs_MarkupListResult", summary: `read markup list job ${jobId}`, input: {
    params: { projectId: project(ctx), fileId: whole(fileId), jobId: whole(jobId) } } });
  const list = r.data?.Markups;
  return Array.isArray(list) && list.length ? list : undefined;
}
