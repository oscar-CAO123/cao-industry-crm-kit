// Asana: a project is the unit of tracking. Progress is the share of its tasks complete; a project status is the
// client-facing update. Field names from Asana's official OpenAPI spec (TaskCreateRequest, ProjectStatusRequest,
// TaskCountResponse). Asana wraps every body and most responses in a `data` object.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Adapter, type Settings, type Tracked, GID, keyOf, latest, ts } from "../types.ts";

const P = "asana" as const;

export const asana: Adapter = {
  id: P,
  /** Active projects in the configured workspace (limited to project_gids when given). */
  async open(ctx) {
    const ws = ctx.settings.asana?.workspace_gid;
    if (!ws || !GID.test(ws)) return [];
    const only = new Set(ctx.settings.asana?.project_gids ?? []);
    const r = await ctx.draft<any>({ platform: P, op: "getProjectsForWorkspace", summary: "read active projects in the workspace",
      input: { params: { workspace_gid: ws, archived: false, limit: 100 } } });
    const rows: any[] = r.data?.data ?? [];
    return rows
      .filter((p) => GID.test(String(p.gid)) && (only.size === 0 || only.has(String(p.gid))))
      .map((p) => ({
        key: keyOf(`asana:${p.gid}`),
        platform: P,
        ref: { project_gid: String(p.gid) },
        title: String(p.name ?? "Project").slice(0, 120),
        status: "In progress",
        contact: {},
      }));
  },
  async refresh(ctx, t) {
    const pg = t.ref.project_gid;
    if (!GID.test(pg)) throw new Error("asana: bad project gid on the tracking record");
    const counts = (await ctx.draft<any>({ platform: P, op: "getTaskCountsForProject", summary: `task counts for project ${pg}`,
      input: { params: { project_gid: pg } } })).data?.data ?? {};
    const total = Number(counts.num_tasks ?? 0), done = Number(counts.num_completed_tasks ?? 0);
    const tasks: any[] = (await ctx.draft<any>({ platform: P, op: "getTasksForProject", summary: `tasks of project ${pg}`,
      input: { params: { project_gid: pg, completed_since: "1970-01-01T00:00:00.000Z", limit: 100, opt_fields: ["modified_at"] } } })).data?.data ?? [];
    const changed = tasks.map((x) => ts(x.modified_at)).filter((x): x is string => !!x);
    return { status: total > 0 && done >= total ? "Completed" : "In progress", last_activity: latest(t.last_activity, ...changed) };
  },
  /** An internal note: a task in the project that the team works from. A draft operation. */
  async note(ctx, t, text) {
    await ctx.draft({ platform: P, op: "createTask", summary: `internal note task in project ${t.ref.project_gid}`,
      input: { body: { data: { name: `Job tracker: ${text}`.slice(0, 250), projects: [t.ref.project_gid] } } } });
  },
  /** Queued only. A project status notifies every follower, so it waits for a person. */
  async clientMessage(ctx, t, subject, text, key) {
    return ctx.queue({ platform: P, op: "createProjectStatusForProject", key,
      summary: `Project status "${subject}" on ${t.title} (notifies every follower)`,
      input: { params: { project_gid: t.ref.project_gid }, body: { data: { title: subject.slice(0, 200), text: text.slice(0, 4000), color: t.stalled ? "yellow" : "green" } } } });
  },
};
