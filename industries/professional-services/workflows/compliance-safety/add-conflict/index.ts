// The conflict check workflow's three crons. Each reads, records in the store and queues. None of them writes to the
// practice system directly: opening a lead is a live operation and waits for a person's approval.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import type { Hit, Lead, Party, Settings } from "./types.ts";
import { newLeads, partiesOf, nameMatches, openLead } from "./adapters/smokeball.ts";

/** Every 15 minutes: new leads from the practice system. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const m of await newLeads(ctx)) {
    if (await ctx.store.get("leads", m.id)) continue;
    await ctx.store.put("leads", m.id, { ...m, status: "new", parties: [], hits: [] } satisfies Lead);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: read the parties on each new lead and search the contacts for their names. Records the result only. */
export async function check(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Lead>("leads")).filter((l) => l.status === "new");
  let hit = 0, clear = 0, no_parties = 0;
  for (const l of todo) {
    const parties: Party[] = await partiesOf(ctx, l.id);
    if (!parties.length) { no_parties++; continue; }   // stays new: read again on the next run
    const own = new Set(parties.map((p) => p.contact_id));
    const hits: Hit[] = [];
    const seen = new Set<string>();
    for (const p of parties) for (const h of await nameMatches(ctx, p, own)) {
      const k = `${h.party}|${h.contact_id}`;
      if (!seen.has(k)) { seen.add(k); hits.push(h); }
    }
    const status = hits.length ? "hit" : "clear";
    if (status === "hit") hit++; else clear++;
    await ctx.store.put("leads", l.id, { ...l, status, parties, hits, checked: ctx.now.toISOString() } satisfies Lead);
  }
  ctx.log(`check: ${clear} clear, ${hit} with name matches, ${no_parties} with no parties yet`);
  return { clear, hit, no_parties };
}

/** Hourly: a lead with no name matches is queued to open as a matter. The partner approves it; nothing opens by itself. */
export async function openMatter(ctx: Ctx<Settings>) {
  let queued = 0;
  for (const l of Object.values(await ctx.store.list<Lead>("leads"))) {
    if (l.status !== "clear") continue;
    const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `open:${l.id}`));
    if (ap?.status === "done") { await ctx.store.put("leads", l.id, { ...l, status: "opened" } satisfies Lead); continue; }
    await ctx.queue({ ...openLead(l.id), key: `open:${l.id}` },
      `Open ${l.title} as a matter in Smokeball: ${l.parties.length} parties, no name matches`);
    queued++;
  }
  ctx.log(`open-matter: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, check, openMatter };
