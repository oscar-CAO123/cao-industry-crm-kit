// Deputy: what a venue spent on labour and what it sold on one day. Both calls are reads, so both sit on the draft list.
// Field names come from Deputy's own API reference: Timesheet (Date, OperationalUnit, Cost, Discarded, IsLeave) and the
// v2 metrics raw endpoint (area, type, value). A Deputy company in another region only changes DEPUTY_REGION.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { DAY, round, type Settings } from "../types.ts";

const P = "deputy";
const MAX_ROWS = 500;

/** Labour cost in dollars for one venue on one local day: its timesheets, minus discarded ones and leave. */
export async function labourCost(ctx: Ctx<Settings>, area: number, day: string): Promise<number> {
  if (!DAY.test(day) || !Number.isInteger(area)) throw new Error("deputy: bad area or day");
  const r = await ctx.draft<any>({ platform: P, op: "deputy-v1-resource-api.searchTimesheet", summary: `timesheets for area ${area} on ${day}`,
    input: { body: { search: { s1: { field: "Date", data: day, type: "eq" }, s2: { field: "OperationalUnit", data: area, type: "eq" } }, max: MAX_ROWS } } });
  const rows: any[] = Array.isArray(r.data) ? r.data : [];
  // A full page may mean rows were cut off, and a short labour figure would look like a good day. Fail loudly instead.
  if (rows.length >= MAX_ROWS) throw new Error(`deputy: ${rows.length} timesheets for area ${area} on ${day}, more than one page: narrow the search before trusting it`);
  return round(rows.filter((t) => t.Discarded !== true && t.IsLeave !== true)
    .reduce((a, t) => a + (Number.isFinite(Number(t.Cost)) ? Number(t.Cost) : 0), 0));
}

/** Sales in dollars for one venue on one local day, from Deputy's sales metrics. */
export async function sales(ctx: Ctx<Settings>, area: number, day: string, offsetHours: number): Promise<number> {
  if (!DAY.test(day) || !Number.isInteger(area)) throw new Error("deputy: bad area or day");
  // Venue-local midnight to the last second of the day, as Unix seconds.
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) - Math.round(offsetHours * 3600);
  const end = start + 86400 - 1;
  const r = await ctx.draft<any>({ platform: P, op: "deputy-v2-api.MetricsV2Controller_getRaw", summary: `sales for area ${area} on ${day}`,
    input: { params: { areas: String(area), types: "Sales", start: String(start), end: String(end) } } });
  const rows: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
  return round(rows.filter((x) => Number(x.area) === area && x.type === "Sales")
    .reduce((a, x) => a + (Number.isFinite(Number(x.value)) ? Number(x.value) : 0), 0));
}
