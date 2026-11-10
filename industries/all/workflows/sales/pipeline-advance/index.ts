// The pipeline-advance workflow's two crons. scan reads the open deals and drafts a register of stalled deals in the workflow
// store; queue re-reads each recorded stage move and queues it for approval. Nothing changes in the CRM until a person approves
// a queued stage change. Judgment (what actually happened on a deal) stays with the agent in SKILL.md, which records a move.
import type { Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Adapter, Deal, Finding, Move, Platform, Settings } from "./types.ts";
import { ID, checkSettings, clip, daysSince } from "./types.ts";
import { gohighlevel } from "./adapters/gohighlevel.ts";
import { pipedrive } from "./adapters/pipedrive.ts";

export const ADAPTERS: Record<Platform, Adapter> = { gohighlevel, pipedrive };
const adapter = (s: Settings): Adapter => { checkSettings(s); return ADAPTERS[s.platform]; };
/** Moves queued in one run, so a long list spreads over several runs. */
const QUEUE_LIMIT = 50;

/** Daily: read the open deals and draft the register of stalled deals. Changes nothing in the CRM. */
export async function scan(ctx: Ctx<Settings>) {
  const s = ctx.settings, a = adapter(s), now = ctx.now.toISOString();
  const deals: Deal[] = [];
  let cursor: string | undefined, truncated = false;
  for (;;) {
    const p = await a.page(ctx, cursor);
    deals.push(...p.items);
    if (!p.next || p.next === cursor || p.items.length === 0) break;
    if (deals.length >= s.read_limit) { truncated = true; break; }
    cursor = p.next;
  }

  const found = new Map<string, Finding>();
  for (const d of deals) {
    const days = daysSince(d.lastChange, ctx.now);
    if (!(days >= s.stale_after_days)) continue;
    const key = `stalled:${s.platform}:${d.id}`;
    const shown = Number.isFinite(days) ? `${Math.floor(days)} days with no recorded change` : "no recorded change";
    found.set(key, { key, platform: s.platform, kind: "stalled", id: d.id,
      summary: clip(`${d.title || `Deal ${d.id}`}: ${shown}, in stage ${d.stage}`, 200), status: "open", first_seen: now, seen_at: now });
  }

  // Upsert the register. An open item keeps its first_seen; a resolved item that comes back is open again.
  const prior = await ctx.store.list<Finding>("findings");
  let added = 0, resolved = 0;
  for (const f of found.values()) {
    const prev = prior[f.key];
    if (prev && prev.status === "open") { await ctx.store.put("findings", f.key, { ...prev, seen_at: now }); continue; }
    await ctx.store.put("findings", f.key, { ...f, first_seen: now }); added++;
  }
  // An item is resolved only by a full read: a cut-short read cannot show that a deal has changed.
  if (!truncated) for (const prev of Object.values(prior)) {
    if (prev.platform !== s.platform || prev.status !== "open" || found.has(prev.key)) continue;
    await ctx.store.put("findings", prev.key, { ...prev, status: "resolved", seen_at: now }); resolved++;
  }
  ctx.log(`scan: ${deals.length} open deals read, ${found.size} stalled, ${added} new, ${resolved} resolved${truncated ? " (read cut short at read_limit)" : ""}`);
  return { read: deals.length, stalled: found.size, added, resolved, truncated };
}

/** Daily: re-read each pending stage move, check it still goes forward along the pipeline, and queue it for approval. */
export async function queue(ctx: Ctx<Settings>) {
  const s = ctx.settings, a = adapter(s), now = ctx.now.toISOString();
  // A move is queued when it is pending, or when its approval was closed by the check (the deal changed after it was queued).
  const closedByCheck = async (m: Move) => {
    if (m.status !== "queued" || !m.approval) return false;
    const ap = await ctx.store.get<Approval>("approvals", m.approval);
    return ap?.status === "rejected" && ap.decided_by === "check";
  };
  const moves = Object.values(await ctx.store.list<Move>("moves"));
  const flags = await Promise.all(moves.map((m) => !m.status || m.status === "pending" || closedByCheck(m)));
  const pending = moves.filter((_, i) => flags[i]).slice(0, QUEUE_LIMIT);
  let queued = 0, skipped = 0;
  for (const m of pending) {
    const skip = async (reason: string) => { skipped++; await ctx.store.put("moves", m.deal, { ...m, status: "skipped", reason, at: now }); };
    if (!ID.test(String(m.deal)) || !ID.test(String(m.to))) { await skip("the deal or the stage is not a plain id"); continue; }
    const d = await a.get(ctx, m.deal);
    if (!d) { await skip("deal not found"); continue; }
    if (d.status !== "open") { await skip(`deal is ${d.status || "not open"}, not open`); continue; }
    const from = s.stage_order.indexOf(d.stage), to = s.stage_order.indexOf(m.to);
    if (from < 0) { await skip("the deal's current stage is not in stage_order"); continue; }
    if (to < 0) { await skip("the target stage is not in stage_order"); continue; }
    if (to <= from) { await skip("the move goes backward or stays where it is"); continue; }
    const summary = clip(`Move ${d.title || `deal ${d.id}`} from stage ${d.stage} to ${m.to}: ${clip(m.why, 200)}`, 300);
    const approval = await a.queueMove(ctx, d, m.to, `move:${s.platform}:${d.id}:${d.stage}:${m.to}:${d.lastChange}`, summary);
    await ctx.store.put("moves", m.deal, { ...m, status: "queued", approval, at: now }); queued++;
  }
  ctx.log(`queue: ${queued} stage moves queued for approval, ${skipped} skipped`);
  return { queued, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { scan, queue };
