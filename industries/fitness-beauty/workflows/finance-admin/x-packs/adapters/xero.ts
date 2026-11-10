// Xero: the trial balance at a month end. Read only: the bookkeeper matches the deferred income line to the pack and gift card totals.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function trialBalance(ctx: Ctx<Settings>, date: string): Promise<unknown> {
  if (!DATE.test(date)) throw new Error("xero: date must be YYYY-MM-DD");
  const r = await ctx.draft<any>({ platform: "xero", op: "accounting.getReportTrialBalance", summary: `trial balance at ${date}`, input: { params: { date } } });
  return r.data;
}
