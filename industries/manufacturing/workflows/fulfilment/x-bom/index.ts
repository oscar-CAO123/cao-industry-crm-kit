// The bill of materials workflow's three crons. Each is deterministic: it reads, drafts or queues; it never sends.
// check and draft read and create bills in Unleashed through the SDK gate. revise only queues: a change to a live
// bill reaches the platform only after a person approves it.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type BomPart, type BomRecord, type Problem, type Settings, keyOf, linesHash, productCode, qtyOf } from "./types.ts";
import { CHECK_LINES, findProduct, billFor, availableFor, createBill, queueRevision } from "./adapters/unleashed.ts";

const recordKey = (parent: string) => keyOf(parent);

async function problem(ctx: Ctx<Settings>, parent: string, kind: string, detail: string) {
  const p: Problem = { parent, kind, detail: detail.slice(0, 300), seen: ctx.now.toISOString() };
  await ctx.store.put("problems", keyOf(`${parent}.${kind}`), p);
}

/** Hourly: read each bill that exists, bring the record in step with the platform, and note components short for one unit. Reads and internal notes only. */
export async function check(ctx: Ctx<Settings>) {
  let synced = 0, short = 0;
  for (const spec of ctx.settings.boms ?? []) {
    const rec = await ctx.store.get<BomRecord>("boms", recordKey(spec.parent));
    if (!rec) continue;
    const bill = await billFor(ctx, rec.parent_guid);
    if (!bill) { await problem(ctx, rec.parent, "bill-missing", "the bill is no longer in Unleashed"); continue; }
    const lines: BomPart[] = [];
    for (const l of bill.lines) {
      const code = rec.lines.find((r) => r.guid === l.guid)?.code;
      if (!code) { lines.length = 0; break; }
      lines.push({ code, qty: l.qty, guid: l.guid });
    }
    if (lines.length !== bill.lines.length) {
      await problem(ctx, rec.parent, "unknown-component", "the bill in Unleashed holds a component this workflow did not record");
      continue;
    }
    await ctx.store.put("boms", recordKey(rec.parent), { ...rec, lines, hash: linesHash(lines) } satisfies BomRecord);
    synced++;
    for (const l of lines) {
      const avail = await availableFor(ctx, l.guid);
      if (avail < l.qty) { short++; await problem(ctx, rec.parent, `short-${l.code}`, `${l.code}: ${avail} available, one unit needs ${l.qty}`); }
    }
  }
  ctx.log(`check: ${synced} bills read, ${short} components short`);
  return { synced, short };
}

/** Every 30 minutes: create the bill for each product in settings that has none yet. Internal record only. */
export async function draft(ctx: Ctx<Settings>) {
  let created = 0, parked = 0;
  for (const spec of ctx.settings.boms ?? []) {
    if (await ctx.store.get<BomRecord>("boms", recordKey(spec.parent))) continue;
    try {
      const parentCode = productCode(spec.parent);
      const parent = await findProduct(ctx, parentCode);
      if (!parent) { parked++; await problem(ctx, parentCode, "missing-product", "not an active product in Unleashed"); continue; }
      if (await billFor(ctx, parent.guid)) {
        parked++; await problem(ctx, parentCode, "bill-exists", "Unleashed already holds a bill for this product; compare it by hand, this workflow does not take it over");
        continue;
      }
      const lines: BomPart[] = [], missing: string[] = [];
      for (const l of spec.lines) {
        const c = productCode(l.code), q = qtyOf(l.qty);
        if (c === parentCode) throw new Error("a bill cannot hold its own product");
        const p = await findProduct(ctx, c);
        if (p) lines.push({ code: c, qty: q, guid: p.guid }); else missing.push(c);
      }
      if (missing.length) {
        parked++; await problem(ctx, parentCode, "missing-component", `not active products in Unleashed: ${missing.join(", ").slice(0, 200)}`);
        continue;
      }
      const billGuid = await createBill(ctx, parent.guid, lines);
      await ctx.store.put("boms", recordKey(parentCode), { parent: parentCode, parent_guid: parent.guid, guid: billGuid, hash: linesHash(lines),
        created: ctx.now.toISOString(), lines } satisfies BomRecord);
      created++;
    } catch (e: any) {
      parked++; await problem(ctx, spec.parent, "refused", String(e?.message ?? e));
    }
  }
  ctx.log(`draft: ${created} bills created, ${parked} parked`);
  return { created, parked };
}

/** Daily: when settings differ from the bill the workflow recorded, queue the change for approval. Queues only. */
export async function revise(ctx: Ctx<Settings>) {
  let queued = 0, parked = 0;
  for (const spec of ctx.settings.boms ?? []) {
    const rec = await ctx.store.get<BomRecord>("boms", recordKey(spec.parent));
    if (!rec) continue;
    try {
      const lines = spec.lines.map((l) => ({ code: productCode(l.code), qty: qtyOf(l.qty) }));
      const hash = linesHash(lines);
      if (hash === rec.hash) continue;
      const parts: BomPart[] = [], missing: string[] = [];
      for (const l of lines) {
        const hit = rec.lines.find((r) => r.code === l.code);
        if (hit) parts.push({ code: l.code, qty: l.qty, guid: hit.guid }); else missing.push(l.code);
      }
      if (missing.length) {
        parked++;
        await problem(ctx, rec.parent, "new-component", `not on the live bill yet: ${missing.join(", ").slice(0, 200)}. This workflow does not add components to a live bill; a person does`);
        continue;
      }
      if (rec.lines.length < 1 || rec.lines.length > CHECK_LINES) {
        parked++;
        await problem(ctx, rec.parent, "unverifiable-bill", `the live bill has ${rec.lines.length} components; the send checks 1 to ${CHECK_LINES} of them, so a person makes this change`);
        continue;
      }
      await queueRevision(ctx, rec, parts, hash);
      queued++;
    } catch (e: any) {
      parked++; await problem(ctx, spec.parent, "refused", String(e?.message ?? e));
    }
  }
  ctx.log(`revise: ${queued} changes queued for approval, ${parked} parked`);
  return { queued, parked };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { check, draft, revise };
