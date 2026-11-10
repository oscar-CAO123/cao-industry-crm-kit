// Deputy: timesheet reads and an internal review comment. Field names come from the vendor spec
// (Timesheet, EmployeeComment, addCommentTimesheet body Comment, QueryRequest search clauses).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings, TimesheetRow } from "../types.ts";

const OP = {
  search: "deputy-v1-resource-api.searchTimesheet",
  comments: "deputy-v1-resource-api.getCommentsTimesheet",
  addComment: "deputy-v1-resource-api.addCommentTimesheet",
} as const;

/** Timesheets dated on or after the lookback start (first page of Deputy's search results). */
export async function timesheetsSince(ctx: Ctx<Settings>, days: number): Promise<TimesheetRow[]> {
  const from = new Date(ctx.now.getTime() - days * 864e5).toISOString().slice(0, 10);
  const r = await ctx.draft<TimesheetRow[]>({
    platform: "deputy",
    op: OP.search,
    input: { body: { search: { s1: { field: "Date", type: "ge", data: from } } } },
    summary: `timesheets dated from ${from}`,
  });
  return Array.isArray(r.data) ? r.data : [];
}

/** The comments already on a timesheet (read only). */
export async function commentsOn(ctx: Ctx<Settings>, id: number): Promise<unknown[]> {
  const r = await ctx.draft<unknown[]>({ platform: "deputy", op: OP.comments, input: { params: { id } }, summary: `comments on timesheet ${id}` });
  return Array.isArray(r.data) ? r.data : [];
}

/** Leave one review comment on a timesheet. Internal: the supervisor sees it, nobody outside the business does. */
export async function reviewComment(ctx: Ctx<Settings>, id: number, text: string): Promise<void> {
  await ctx.draft({ platform: "deputy", op: OP.addComment, input: { params: { id }, body: { Comment: text } }, summary: `review comment on timesheet ${id}` });
}
