// The settlement tracker's two crons. Both read the settlement records in the workflow store and write internal
// records only. Neither calls a platform, so neither can send, pay or change a live record.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Checklist, type Settings, type Settlement, checkSettlement, isValidSettlement } from "./types.ts";

/** Every 30 minutes: one checklist per settlement record. Re-runs overwrite the same checklist, never add one. */
export async function checklist(ctx: Ctx<Settings>) {
  const grace = ctx.settings.overdue_after_days ?? 1;
  let written = 0, skipped = 0;
  for (const s of Object.values(await ctx.store.list<Settlement>("settlements"))) {
    if (!isValidSettlement(s)) { skipped++; continue; }
    await ctx.store.put("checklists", s.id, checkSettlement(s, ctx.now, grace));
    written++;
  }
  ctx.log(`checklist: ${written} written, ${skipped} skipped as invalid`);
  return { written, skipped };
}

/** Daily: the settlements past their date with post-settlement checks still open, kept as one internal record. */
export async function overdue(ctx: Ctx<Settings>) {
  const late = Object.values(await ctx.store.list<Checklist>("checklists"))
    .filter((c) => c.status === "overdue").map((c) => c.settlement).sort();
  await ctx.store.put("overdue", "latest", { settlements: late, checked: ctx.now.toISOString() });
  ctx.log(`overdue: ${late.length} past settlement date with checks open`);
  return { overdue: late.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { checklist, overdue };
