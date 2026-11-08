// Asana: one training task per trainee per SOP. The task is created unassigned (a draft operation, inside the business's
// own training project). Assigning it notifies the trainee, so the assignment is a live act that waits for approval.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, NUMID } from "../types.ts";

const P = "asana";
const cfg = (ctx: Ctx<Settings>) => {
  const g = ctx.settings.asana?.project_gid;
  if (!g || !NUMID.test(g)) throw new Error("asana.project_gid is not set");
  return g;
};

export const asana = {
  id: P,
  /** Create an unassigned task in the training project and return its id. */
  async createTask(ctx: Ctx<Settings>, name: string, notes: string): Promise<string> {
    const project = cfg(ctx);
    const r = await ctx.draft<any>({ platform: P, op: "createTask", summary: `create training task "${name}"`, input: { body: {
      data: { name: name.slice(0, 250), notes: notes.slice(0, 10000), projects: [project] } } } });
    const gid = String(r.data?.data?.gid ?? "");
    if (!NUMID.test(gid)) throw new Error("asana: training task not created");
    return gid;
  },
  /** The live act that assigns the task to the trainee. */
  assignAct(gid: string, email: string): Act {
    return { platform: P, op: "updateTask", summary: `assign training task to ${email}`, input: { params: { task_gid: gid }, body: { data: { assignee: email } } } };
  },
};
