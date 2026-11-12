// Onfleet: the platform that holds the tasks and the routes. Reads run on their own; dispatching a team sends its
// routes to the drivers, so that is a live operation and only ever queued for a person to approve.
// Field names come from the vendor's docs (list tasks, create task, route plans, dispatch).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { ID, type Settings, type Stop } from "../types.ts";

const P = "onfleet";
const MAX_PAGES = 20;   // list tasks returns up to 64 per page; a bounded walk keeps one cron run short

const tid = (v: unknown): string => {
  const s = String(v ?? "");
  if (!ID.test(s)) throw new Error("onfleet: bad id");
  return s;
};

const stopOf = (t: any, seen: string): Stop => ({
  id: tid(t.id),
  shortId: typeof t.shortId === "string" ? t.shortId.slice(0, 32) : undefined,
  state: typeof t.state === "number" ? t.state : undefined,
  routed: t.routePlan !== undefined && t.routePlan !== null,
  address: typeof t?.destination?.address?.unparsed === "string" ? t.destination.address.unparsed.slice(0, 300) : undefined,
  completeAfter: typeof t.completeAfter === "number" ? t.completeAfter : null,
  completeBefore: typeof t.completeBefore === "number" ? t.completeBefore : null,
  seen,
});

/** Tasks created or completed since `from` (unix ms), walked page by page. Read only. */
export async function tasksSince(ctx: Ctx<Settings>, from: number): Promise<Stop[]> {
  const out: Stop[] = [];
  let lastId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, unknown> = { from: String(Math.floor(from)) };
    if (lastId) params.lastId = tid(lastId);
    const r = await ctx.draft<{ tasks?: any[]; lastId?: string }>({ platform: P, op: "core.docs.get_tasks_all", summary: "read tasks", input: { params } });
    for (const t of r.data?.tasks ?? []) out.push(stopOf(t, ctx.now.toISOString()));
    if (!r.data?.lastId) break;
    lastId = r.data.lastId;
  }
  return out;
}

/** Route plans that start in the window (unix ms). Read only. The team filter is applied by the caller. */
export async function routePlansIn(ctx: Ctx<Settings>, from: number, to: number): Promise<{ id: string; team?: string; state?: string }[]> {
  const r = await ctx.draft<any[]>({ platform: P, op: "core.docs.get_routePlans", summary: "read route plans",
    input: { params: { startTimeFrom: String(Math.floor(from)), startTimeTo: String(Math.floor(to)) } } });
  return (Array.isArray(r.data) ? r.data : []).map((p: any) => ({
    id: String(p.id ?? "").slice(0, 64), team: typeof p.team === "string" ? p.team : undefined, state: typeof p.state === "string" ? p.state : undefined,
  }));
}

/** Queue the team's auto-dispatch for approval. Nothing reaches a driver until a person approves it. */
export async function queueDispatch(ctx: Ctx<Settings>, team: string, routeEnd: string | null, key: string, summary: string): Promise<string> {
  return ctx.queue({ platform: P, op: "core.docs.post_teams_id_dispatch", summary, key,
    input: { params: { teamId: tid(team) }, body: { routeEnd } } });
}
