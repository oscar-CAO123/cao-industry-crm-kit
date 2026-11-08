// Deputy: the rostering platform this workflow can reach. Every field used here is named in Deputy's official resource
// spec (Roster, Employee, Leave, EmployeeAvailability, Timesheet, RosterSwap). A shift drafted here is Published false,
// so only managers see it. Publishing tells staff, so it is only ever queued for a person to approve.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Shift, int, seconds, label } from "../types.ts";

const P = "deputy";

export interface Employee { Id: number; DisplayName?: string; FirstName?: string; LastName?: string; Active?: boolean; TerminationDate?: string | null }
export interface Roster { Id: number; Employee: number; StartTime: number | string; EndTime: number | string; Date?: string; OperationalUnit?: number; Published?: boolean }
export interface Leave { Id: number; Employee: number; Start: string; End: string; Status?: number }
export interface Timesheet { Id: number; Employee: number; StartTime: number | string; EndTime?: number | string; Roster?: number | null; ValidationFlag?: number }
export interface Swap { Id: number; Employee: number; SourceRoster?: number; TargetRoster?: number; Status?: number }

const list = async <T>(ctx: Ctx<Settings>, op: string, summary: string): Promise<T[]> =>
  ((await ctx.draft<T[]>({ platform: P, op, summary })).data ?? []) as T[];

export const employees = (ctx: Ctx<Settings>) => list<Employee>(ctx, "deputy-v1-resource-api.listEmployee", "read employees");
export const leave = (ctx: Ctx<Settings>) => list<Leave>(ctx, "deputy-v1-resource-api.listLeave", "read leave");
export const rosters = (ctx: Ctx<Settings>) => list<Roster>(ctx, "deputy-v1-resource-api.listRoster", "read rosters");
export const timesheets = (ctx: Ctx<Settings>) => list<Timesheet>(ctx, "deputy-v1-resource-api.listTimesheet", "read timesheets");
export const swaps = (ctx: Ctx<Settings>) => list<Swap>(ctx, "deputy-v1-resource-api.listRosterSwap", "read roster swaps");

/** A private draft shift for one person. Published false: managers see it, staff do not. */
export async function draftShift(ctx: Ctx<Settings>, s: { employee: number; start: number; end: number; date: string }): Promise<number> {
  const body = {
    Employee: int(s.employee, "employee id"),
    OperationalUnit: int(ctx.settings.deputy.operational_unit, "operational unit"),
    StartTime: s.start,
    EndTime: s.end,
    Date: `${s.date}T00:00:00+00:00`,
    Published: false,
    Comment: label("Drafted by the rostering workflow. Not published."),
  };
  const r = await ctx.draft<{ Id: number }>({ platform: P, op: "deputy-v1-resource-api.createRoster", summary: `draft shift for employee ${body.Employee}`, input: { body } });
  return int(r.data?.Id, "roster id returned by Deputy");
}

/** The live act that publishes one shift (Published true). Only ever passed to ctx.queue. */
export function publishAct(sh: Shift): Act {
  const id = int(sh.id, "roster id");
  return {
    platform: P, op: "deputy-v1-resource-api.updateRoster", key: `publish-${id}`,
    input: { params: { id }, body: { Published: true } },
    summary: `publish shift ${id} for ${label(sh.employee_name ?? `employee ${sh.employee}`)}, ${sh.date}`,
  };
}

export const rosterFrom = (r: Roster): Shift => ({
  id: String(r.Id), employee: r.Employee, date: r.Date?.slice(0, 10) ?? "", start: seconds(r.StartTime), end: seconds(r.EndTime), published: r.Published === true,
});
