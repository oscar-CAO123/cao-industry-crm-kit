// The portfolio reviews workflow's three crons. Each reads, drafts or queues. None sends anything: an invite reaches
// the client, so the invite cron only queues it for an adviser's approval.
import type { Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import type { ClientRow, Pack, Settings, Slot } from "./types.ts";
import { dueAt, isoDay, pick } from "./types.ts";
import * as hubspot from "./adapters/hubspot.ts";

/** Daily: read the partner clients and flag each whose review date has come. Reads only. */
export async function reviewDue(ctx: Ctx<Settings>) {
  const hs = ctx.settings.hubspot;
  const endOfToday = Date.parse(`${isoDay(ctx.now)}T23:59:59Z`);
  let due = 0;
  for (const c of await hubspot.clients(ctx)) {
    const when = dueAt(String(c.properties[hs.due_property] ?? ""));
    const isDue = when !== undefined && when <= endOfToday;
    const prev = await ctx.store.get<ClientRow>("reviews", c.id);
    // A review already prepared or invited keeps its place; only a review not yet due is re-flagged.
    const keep = !!prev && prev.status !== "not-due" && prev.status !== "due";
    const status = keep ? prev!.status : isDue ? "due" : "not-due";
    if (status === "due") due++;
    await ctx.store.put("reviews", c.id, {
      id: c.id,
      name: String(c.properties[hs.name_property] ?? c.id).slice(0, 120),
      due: when === undefined ? undefined : new Date(when).toISOString(),
      status,
    } satisfies ClientRow);
  }
  ctx.log(`review-due: ${due} due`);
  return { due };
}

/** Hourly: read each due client and write its review pack. Reads only; the pack stays in the workflow store. */
export async function prepare(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<ClientRow>("reviews")).filter((r) => r.status === "due");
  let prepared = 0;
  for (const r of todo) {
    const c = await hubspot.client(ctx, r.id);
    await ctx.store.put("packs", r.id, {
      id: r.id, name: r.name, due: r.due ?? "",
      properties: pick(c.properties, ctx.settings.hubspot.pack_properties),
      prepared: ctx.now.toISOString(),
    } satisfies Pack);
    await ctx.store.put("reviews", r.id, { ...r, status: "prepared" } satisfies ClientRow);
    prepared++;
  }
  ctx.log(`prepare: ${prepared} packs`);
  return { prepared };
}

/** Every 15 minutes: queue the invite for each prepared client whose agreed slot is in the store. A client whose invite
 *  was rejected goes back to prepared and is queued again as a new approval. Queues only. */
export async function invite(ctx: Ctx<Settings>) {
  const rows = Object.values(await ctx.store.list<ClientRow>("reviews"));
  let queued = 0, waiting = 0, bad = 0, requeued = 0;
  for (let r of rows) {
    if (r.status === "invite-queued" && r.invite_approval) {
      const ap = await ctx.store.get<Approval>("approvals", r.invite_approval);
      if (ap?.status !== "rejected") continue; // still waiting for an adviser, or already approved
      r = { ...r, status: "prepared", invite_round: (r.invite_round ?? 0) + 1 };
      await ctx.store.put("reviews", r.id, r satisfies ClientRow);
      requeued++;
    }
    if (r.status !== "prepared") continue;
    const slot = await ctx.store.get<Slot>("slots", r.id);
    if (!slot) { waiting++; continue; }
    let approval: string;
    try {
      approval = await hubspot.queueInvite(ctx, { id: r.id, name: r.name }, slot, r.invite_round ?? 0);
    } catch (e: any) {
      bad++;
      ctx.log(`invite: ${r.id} not queued: ${String(e?.message ?? e).slice(0, 120)}`);
      continue;
    }
    await ctx.store.put("reviews", r.id, { ...r, status: "invite-queued", invite_approval: approval } satisfies ClientRow);
    queued++;
  }
  ctx.log(`invite: ${queued} queued, ${requeued} requeued after rejection, ${waiting} waiting for a slot, ${bad} refused`);
  return { queued, waiting_for_slot: waiting, refused: bad };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "review-due": reviewDue, prepare, invite };
