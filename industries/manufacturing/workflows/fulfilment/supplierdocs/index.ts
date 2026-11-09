// The supplier documents workflow's three crons. Each reads, drafts in the store, or queues for approval. None sends
// or authorises anything on its own: authorising a bill is a live operation that a person approves.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { xero } from "./adapters/xero.ts";
import { type Doc, type Settings, money } from "./types.ts";

const NEEDS_CHECK = (d: Doc) => d.status === "new" || d.status === "needs-review";

/** Every 10 minutes: new draft supplier bills from Xero become documents to process. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const b of await xero.bills(ctx)) {
    if (await ctx.store.get("documents", b.id)) continue;
    await ctx.store.put("documents", b.id, b);
    added++;
  }
  ctx.log(`intake: ${added} new supplier bills`);
  return { added };
}

/** Every 15 minutes: match each bill line to a Xero item (its item code is the SKU). Anything unmatched, or priced
 *  outside the tolerance against the item's purchase price, is needs-review for a person. */
export async function match(ctx: Ctx<Settings>) {
  const docs = Object.values(await ctx.store.list<Doc>("documents")).filter((d) => NEEDS_CHECK(d) && !d.changed);
  if (!docs.length) return { matched: 0, needs_review: 0 };
  const byCode = new Map((await xero.items(ctx)).map((i) => [i.code.toLowerCase(), i]));
  const tol = Math.max(0, ctx.settings.price_tolerance_percent ?? 2);
  let matched = 0, review = 0;
  for (const d of docs) {
    const reasons: string[] = [];
    if (!d.lines.length) reasons.push("the bill has no lines");
    d.lines = d.lines.map((l) => {
      const it = l.code ? byCode.get(l.code.toLowerCase()) : undefined;
      if (!it) { reasons.push(`no Xero item for ${l.code || `"${l.description}"`}`); return { ...l, sku: undefined, cost: undefined }; }
      if (!(it.cost > 0)) reasons.push(`${it.code} has no purchase price in Xero`);
      else if (Math.abs(l.unit - it.cost) / it.cost * 100 > tol) reasons.push(`${it.code} billed at ${money(l.unit)}, Xero says ${money(it.cost)}`);
      return { ...l, sku: it.code, cost: it.cost };
    });
    d.reasons = reasons.slice(0, 20);
    d.status = reasons.length ? "needs-review" : "matched";
    if (d.status === "matched") matched++; else review++;
    await ctx.store.put("documents", d.id, d);
  }
  ctx.log(`match: ${matched} matched, ${review} need review`);
  return { matched, needs_review: review };
}

/** Hourly: queue each clean bill for authorisation, and record what the approver did with the ones already queued.
 *  The authorise call authorises what Xero holds when it runs, so each clean bill is read again first: a bill whose total
 *  or line count moved since matching is not queued, and waits for a person. */
export async function publish(ctx: Ctx<Settings>) {
  const docs = Object.values(await ctx.store.list<Doc>("documents"));
  let queued = 0, authorised = 0, rejected = 0, held = 0;
  let inXero: Map<string, Doc> | undefined;
  for (const d of docs) {
    if (d.status === "queued") {
      const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `authorise:${d.id}`));
      if (ap?.status === "done") { d.status = "authorised"; authorised++; await ctx.store.put("documents", d.id, d); }
      else if (ap?.status === "rejected") { d.status = "rejected"; d.reasons = ["authorisation was rejected: check the bill in Xero before it is matched again"]; rejected++; await ctx.store.put("documents", d.id, d); }
      continue;
    }
    if (d.status !== "matched") continue;
    inXero ??= new Map((await xero.bills(ctx)).map((b) => [b.id, b]));
    const now = inXero.get(d.id);
    const drift = !now ? "it is no longer a draft in Xero"
      : now.lines.length !== d.lines.length || Math.abs(now.total - d.total) > 0.005
        ? `Xero now has ${now.lines.length} lines and ${money(now.total)}, matched as ${d.lines.length} lines and ${money(d.total)}` : "";
    if (drift) {
      d.status = "needs-review";
      d.changed = `Changed in Xero after matching: ${drift}. Check the bill before it is queued.`;
      d.reasons = [d.changed];
      await ctx.store.put("documents", d.id, d);
      held++;
      continue;
    }
    d.approval = await ctx.queue(xero.authoriseAct(d),
      `Authorise bill ${d.number || d.id} from ${d.supplier || "the supplier"} in Xero: ${d.lines.length} lines, ${money(d.total)}`);
    d.status = "queued";
    await ctx.store.put("documents", d.id, d);
    queued++;
  }
  ctx.log(`publish: ${queued} queued, ${authorised} authorised, ${rejected} rejected, ${held} held for a change in Xero`);
  return { queued, authorised, rejected };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, match, publish };
