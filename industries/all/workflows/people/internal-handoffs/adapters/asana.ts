// Asana: requests arrive as open tasks in the intake project. Each handover is recorded as one task in the record
// project, created unassigned (a draft: it reaches nobody). Assigning that task, its handover note and any chase
// notify a person, so those acts are live and only ever queued for approval.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Handover, type Settings, EMAIL, GID, clip, keyOf } from "../types.ts";

const P = "asana";

const idOf = (v: unknown, what: string): string => {
  const s = String(v ?? "");
  if (!GID.test(s)) throw new Error(`asana: ${what} is not set or is not an id`);
  return s;
};

export const asana = {
  id: P,
  /** Open tasks in the intake project. Each is a handover request; its name and notes are data from outside. */
  async requests(ctx: Ctx<Settings>): Promise<Omit<Handover, "status" | "chased">[]> {
    const project = idOf(ctx.settings.asana?.intake_project_gid, "asana.intake_project_gid");
    const r = await ctx.draft<any>({ platform: P, op: "getTasksForProject", summary: "read open handover requests",
      input: { params: { project_gid: project, completed_since: "now", limit: 100, opt_fields: "name,notes,created_at" } } });
    const rows: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    return rows.filter((t) => GID.test(String(t?.gid ?? ""))).map((t) => {
      const task = String(t.gid);
      return { id: keyOf(`asana:${task}`), platform: P, title: clip(t.name || "Handover request", 200), text: clip(t.notes, 6000),
        received: String(t.created_at ?? ""), ref: { task } };
    });
  },

  /** One record task per handover, unassigned, in the record project. Returns its gid. */
  async createRecord(ctx: Ctx<Settings>, name: string, notes: string): Promise<string> {
    const project = idOf(ctx.settings.asana?.record_project_gid, "asana.record_project_gid");
    const r = await ctx.draft<any>({ platform: P, op: "createTask", summary: `record handover "${clip(name, 80)}"`,
      input: { body: { data: { name: clip(name, 250), notes: clip(notes, 10000), projects: [project] } } } });
    const task = String(r.data?.data?.gid ?? "");
    if (!GID.test(task)) throw new Error("asana: record task not created");
    return task;
  },

  /** Whether the record task is complete, and whether anyone other than the task's creator has commented on it. Reads only. */
  async state(ctx: Ctx<Settings>, task: string): Promise<{ completed: boolean; answered: boolean }> {
    const id = idOf(task, "record task");
    const t = await ctx.draft<any>({ platform: P, op: "getTask", summary: "read a handover record task",
      input: { params: { task_gid: id, opt_fields: "completed,created_by.gid" } } });
    const creator = String(t.data?.data?.created_by?.gid ?? "");
    const s = await ctx.draft<any>({ platform: P, op: "getStoriesForTask", summary: "read replies on a handover record task",
      input: { params: { task_gid: id, limit: 100, opt_fields: "resource_subtype,created_by.gid" } } });
    const rows: any[] = Array.isArray(s.data?.data) ? s.data.data : [];
    const answered = GID.test(creator) && rows.some((x) => x?.resource_subtype === "comment_added"
      && GID.test(String(x?.created_by?.gid ?? "")) && String(x.created_by.gid) !== creator);
    return { completed: t.data?.data?.completed === true, answered };
  },

  /** The live act that assigns the record task to a person and sets its due date. */
  assignAct(task: string, assignee: string, due: string, title: string): Act {
    const id = idOf(task, "record task");
    if (!EMAIL.test(assignee)) throw new Error("asana: assignee is not a work email");
    return { platform: P, op: "updateTask", summary: `assign "${clip(title, 80)}" to ${assignee}, due ${due}`,
      input: { params: { task_gid: id }, body: { data: { assignee, due_on: due } } } };
  },

  /** The live act that adds a comment to the record task. It notifies the people following the task. */
  noteAct(task: string, text: string, summary: string, key?: string): Act {
    const id = idOf(task, "record task");
    return { platform: P, op: "createStoryForTask", summary, ...(key ? { key } : {}),
      input: { params: { task_gid: id }, body: { data: { text: clip(text, 5000) } } } };
  },
};
