// Xero Projects, read only: each project's estimate, task and expense totals and minutes logged.
// Fields come from the vendor spec (xero-projects: Project). Only the first page is read (see gaps in workflow.json).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, toJob } from "../types.ts";

const P = "xero";

export const xero: Adapter = {
  id: P,
  async projects(ctx: Ctx<Settings>) {
    const r = await ctx.draft<any>({ platform: P, op: "projects.getProjects", summary: "read projects and their totals", input: {} });
    return (r.data?.items ?? []).map(toJob).filter((j: { id: string }) => j.id);
  },
};
