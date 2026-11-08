// The add-proposal workflow's three crons. Each reads, drafts or queues; none publishes a quote on its own.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { HS_ID, type Proposal, type Settings } from "./types.ts";
import { createDraftQuote, readQuoteStatus, publishAct } from "./adapters/hubspot.ts";

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Every 15 minutes: create a draft quote in HubSpot for each scoped proposal. Nothing reaches the client. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Proposal>("proposals")).filter((p) => p.status === "scoped");
  let drafted = 0;
  for (const p of todo) {
    if (!(Number.isFinite(p.fee_ex_gst) && p.fee_ex_gst > 0 && p.fee_ex_gst <= 10_000_000) || !HS_ID.test(String(p.contact_id))) {
      ctx.log(`draft: ${p.id} has no valid fee or contact, skipped`);
      continue;
    }
    const quote_id = await createDraftQuote(ctx, p);
    await ctx.store.put("proposals", p.id, { ...p, status: "drafted", quote_id } satisfies Proposal);
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted`);
  return { drafted };
}

/** Hourly: read each open quote's status in HubSpot and record published, accepted or declined. */
export async function status(ctx: Ctx<Settings>) {
  const v = ctx.settings.hubspot.status_values;
  const open = Object.values(await ctx.store.list<Proposal>("proposals"))
    .filter((p) => ["drafted", "publish-queued", "published"].includes(p.status) && p.quote_id);
  let changed = 0;
  for (const p of open) {
    const s = await readQuoteStatus(ctx, p.quote_id!);
    const next: Proposal["status"] = s === v.accepted ? "accepted" : s === v.declined ? "declined" : s === v.published ? "published" : p.status;
    if (next !== p.status) { await ctx.store.put("proposals", p.id, { ...p, status: next } satisfies Proposal); changed++; }
  }
  ctx.log(`status: ${changed} changed`);
  return { changed };
}

/** Daily: queue publishing of each drafted quote. The approval runs the publish; the cron never does. */
export async function publish(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Proposal>("proposals")).filter((p) => p.status === "drafted" && p.quote_id);
  for (const p of todo) {
    await ctx.queue(publishAct(ctx, p), `Publish quote for ${p.title}, ${money(p.fee_ex_gst)} ex GST, so the client can see it`);
    await ctx.store.put("proposals", p.id, { ...p, status: "publish-queued" } satisfies Proposal);
  }
  ctx.log(`publish: ${todo.length} queued`);
  return { queued: todo.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { draft, status, publish };
