// The photocheck workflow's three crons. Each reads, drafts or queues; none sends.
// Judgment (looking at the photos, measuring, comparing to the drawing) belongs to the agent skill in SKILL.md, which
// records a result on the check; the report cron turns a recorded result into a queued email.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Check, Settings } from "./types.ts";
import { requests, logRow, draftResult, sendAct } from "./adapters/microsoft-365.ts";

/** Every 10 minutes: new finished-part check requests from the request folder. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const r of await requests(ctx)) {
    if (await ctx.store.get("checks", r.id)) continue;
    await ctx.store.put("checks", r.id, { ...r, status: "new" } satisfies Check);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: one register row per new request, status Awaiting photo check. */
export async function register(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Check>("checks")).filter((c) => c.status === "new");
  for (const c of todo) {
    const row = await logRow(ctx, c);
    await ctx.store.put("checks", c.id, { ...c, status: "logged", ref: { ...c.ref, register_row: String(row) } } satisfies Check);
  }
  ctx.log(`register: ${todo.length} logged`);
  return { logged: todo.length };
}

/** Every 30 minutes: for each recorded result, draft the customer email once and queue its send for approval. */
export async function report(ctx: Ctx<Settings>) {
  let queued = 0;
  for (const c of Object.values(await ctx.store.list<Check>("checks"))) {
    if (c.status !== "result-ready" || !c.result || !c.contact.email) continue;
    let messageId = c.ref?.draft_message;
    if (!messageId) {
      messageId = await draftResult(ctx, c);
      c.ref = { ...c.ref, draft_message: messageId };
      await ctx.store.put("checks", c.id, c);   // saved before the queue, so a failed queue reuses this draft on the next run
    }
    // Explicit summary: the runtime logs it, so it names the check, not the customer's address (the act keeps the address).
    await ctx.queue(sendAct(ctx, c, messageId), `send result for check ${c.id.slice(0, 20)}: ${c.result?.decision}`);  // returns the existing approval id if it is already queued
    await ctx.store.put("checks", c.id, { ...c, status: "queued" } satisfies Check);
    queued++;
  }
  ctx.log(`report: ${queued} queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, register, report };
