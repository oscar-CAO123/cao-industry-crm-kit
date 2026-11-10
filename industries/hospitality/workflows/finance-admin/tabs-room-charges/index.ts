// The tabs and room charges workflow's two crons. Each one reads and drafts; neither changes a guest's bill.
// Posting a charge to a folio is a live operation (workflow.json) and is not wired yet: see gaps there.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings } from "./types.ts";

const FOLIO_CONFIG = "accounting-v1-0-openapi.getFolioConfigurations";
const TRIAL_BALANCE = "accounting-v1-0-openapi.getTrialBalanceReport";

/** Validate the property number from settings before it goes into a request header. */
function propertyId(s: Settings): number {
  const n = Number(s.property_id);
  if (!Number.isInteger(n) || n <= 0) throw new Error("tabs-room-charges: settings.property_id must be a positive whole number");
  return n;
}
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Every 30 minutes: read the folio configurations the property uses and keep the latest copy for the agent. */
export async function folioConfig(ctx: Ctx<Settings>) {
  const pid = propertyId(ctx.settings);
  const r = await ctx.draft({ platform: "cloudbeds", op: FOLIO_CONFIG, input: { params: { "X-Property-ID": pid } }, summary: "read folio configurations" });
  await ctx.store.put("folio-config", String(pid), { at: ctx.now.toISOString(), data: r.data });
  ctx.log(`folio-config: stored for property ${pid}`);
  return { status: r.status };
}

/** Nightly: read the trial balance for the day and keep it as the night auditor's starting figures. */
export async function reconcile(ctx: Ctx<Settings>) {
  const pid = propertyId(ctx.settings);
  const date = day(ctx.now);
  const r = await ctx.draft({ platform: "cloudbeds", op: TRIAL_BALANCE, input: { params: { "X-Property-ID": pid, date } }, summary: `read trial balance for ${date}` });
  await ctx.store.put("trial-balance", `${pid}-${date}`, { at: ctx.now.toISOString(), data: r.data });
  ctx.log(`reconcile: trial balance stored for ${date}`);
  return { date, status: r.status };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "folio-config": folioConfig, reconcile };
