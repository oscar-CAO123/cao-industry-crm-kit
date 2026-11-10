// The returns workflow's two crons. Both are deterministic: intake reads, draft queues a reply for approval. Neither sends.
// Judgment (the refund or exchange, the label, the check-in, the restock) stays with staff, as SKILL.md describes.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Adapter, type Platform, type Request, type Settings, replyText } from "./types.ts";
import { googleWorkspace } from "./adapters/google-workspace.ts";
import { gorgias } from "./adapters/gorgias.ts";

export const ADAPTERS: Record<Platform, Adapter> = { "google-workspace": googleWorkspace, gorgias };

/** Every 10 minutes: new return requests from each intake source. Reads only. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const p of ctx.settings.intake) {
    for (const r of await ADAPTERS[p].requests!(ctx)) {
      if (await ctx.store.get("requests", r.id)) continue;
      await ctx.store.put("requests", r.id, { ...r, status: "new" } satisfies Request);
      added++;
    }
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: queue the returns-form reply for each new request. The send waits for a person to approve it. */
export async function draft(ctx: Ctx<Settings>) {
  const text = replyText(ctx.settings);
  let queued = 0, failed = 0;
  for (const r of Object.values(await ctx.store.list<Request>("requests"))) {
    if (r.status !== "new") continue;
    try {
      const approval = await ADAPTERS[r.source].queueReply!(ctx, r, text);
      await ctx.store.put("requests", r.id, { ...r, status: "queued", approval, queued_at: ctx.now.toISOString() } satisfies Request);
      queued++;
    } catch (e: any) {
      failed++;
      ctx.log(`draft: ${r.id} not queued: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  ctx.log(`draft: ${queued} replies queued, ${failed} failed`);
  return { queued, failed };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft };
