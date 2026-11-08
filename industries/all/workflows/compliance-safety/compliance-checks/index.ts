// The compliance-checks workflow's two crons. Each is deterministic: case-watch reads and records, open-items queues a note
// for a compliance person. Nothing here clears a check, changes a case status or lodges a report.
import crypto from "node:crypto";
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { listCases, readCase, noteInput } from "./adapters/first-aml.ts";
import type { CaseRecord, Settings } from "./types.ts";

const DAY = 864e5;

/** Every 30 minutes: read cases updated since the last run and record each person's and entity's check state. */
export async function caseWatch(ctx: Ctx<Settings>) {
  const cur = await ctx.store.get<{ updated_after?: string }>("cursor", "first-aml");
  const days = ctx.settings.first_aml?.lookback_days ?? 30;
  const since = cur?.updated_after ?? new Date(ctx.now.getTime() - days * DAY).toISOString();
  const found = await listCases(ctx, since, ctx.settings.first_aml?.max_pages ?? 5);
  let latest = since;
  for (const c of found) {
    const rec: CaseRecord = { ...(await readCase(ctx, c.caseId)), caseStatus: c.caseStatus, lastUpdatedOn: c.lastUpdatedOn };
    await ctx.store.put("cases", rec.caseId, rec);
    if (c.lastUpdatedOn && c.lastUpdatedOn > latest) latest = c.lastUpdatedOn;
  }
  if (found.length) await ctx.store.put("cursor", "first-aml", { updated_after: latest });
  ctx.log(`case-watch: ${found.length} cases read`);
  return { read: found.length };
}

/** Every hour: for each case with an open screening or verification result, queue one note listing the person IDs and checks. */
export async function openItems(ctx: Ctx<Settings>) {
  const cases = Object.values(await ctx.store.list<CaseRecord>("cases"));
  let queued = 0;
  for (const c of cases) {
    const open = c.people.filter((p) => p.state === "open");
    if (!open.length) continue;
    const text = open.map((p) => `${p.kind} ${p.id}: ${p.open.join(", ")}`).join("; ");
    const digest = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
    const note = `Open items for compliance review (${ctx.now.toISOString().slice(0, 10)}): ${text}. A person clears or escalates each item.`;
    const summary = `Add an open-items note to case ${c.caseId}: ${open.length} person(s) with open checks`;
    await ctx.queue({ platform: "first-aml", op: "mutation.addCaseNote", input: noteInput(c.caseId, note), summary, key: `note:${c.caseId}:${digest}` }, summary);
    queued++;
  }
  ctx.log(`open-items: ${queued} notes queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "case-watch": caseWatch, "open-items": openItems };
