// The barcode compliance workflow's two crons. Each is deterministic: it reads, checks against GS1 rules, and queues.
// A barcode change reaches the product master only after a person approves it in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { unleashed } from "./adapters/unleashed.ts";
import { type Finding, type Fix, type Settings, gtin14, gtinProblems, isGuid } from "./types.ts";

export const ADAPTERS = { unleashed };

/** Daily: check every active product's barcode for GS1 format, check digit and duplicates; store the findings. */
export async function checkBarcodes(ctx: Ctx<Settings>) {
  const { products, more } = await unleashed.products(ctx);
  const owners = new Map<string, string[]>();
  for (const p of products) {
    if (p.obsolete || !p.barcode.trim()) continue;
    const k = gtin14(p.barcode);
    owners.set(k, [...(owners.get(k) ?? []), p.code]);
  }
  const checked = ctx.now.toISOString();
  let flagged = 0;
  for (const p of products) {
    if (p.obsolete) continue;
    const problems = gtinProblems(p.barcode);
    const others = p.barcode.trim() ? (owners.get(gtin14(p.barcode)) ?? []).filter((c) => c !== p.code) : [];
    if (others.length) problems.push(`same barcode as ${others.slice(0, 3).join(", ")}`);
    const f: Finding = { guid: p.guid, code: p.code, barcode: p.barcode, problems, status: problems.length ? "flagged" : "ok", checked };
    if (problems.length) flagged++;
    await ctx.store.put("barcode-findings", p.guid, f);
  }
  await ctx.store.put("barcode-runs", "latest", { checked, products: products.length, flagged, partial: more });
  ctx.log(`check-barcodes: ${products.length} products, ${flagged} flagged${more ? ", first page only (the catalogue has more pages)" : ""}`);
  return { products: products.length, flagged, partial: more };
}

/** Every 30 minutes: a corrected GTIN a person has recorded becomes one queued barcode update, once. */
export async function queueFixes(ctx: Ctx<Settings>) {
  const fixes = await ctx.store.list<Fix>("barcode-fixes");
  let queued = 0, refused = 0;
  for (const [key, f] of Object.entries(fixes)) {
    if (f.approval) continue;
    if (!isGuid(f.product) || gtinProblems(f.barcode).length) {
      refused++;
      ctx.log(`queue-fixes: ${key} refused, the product id or the GTIN is not valid`);
      continue;
    }
    const p = await unleashed.product(ctx, f.product);
    const approval = await ctx.queue(unleashed.setBarcodeAct(p, f.barcode), `set barcode on ${p.code} to ${f.barcode} (now ${p.barcode || "empty"})`);
    await ctx.store.put("barcode-fixes", key, { ...f, approval } satisfies Fix);
    queued++;
  }
  ctx.log(`queue-fixes: ${queued} queued for approval, ${refused} refused`);
  return { queued, refused };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "check-barcodes": checkBarcodes, "queue-fixes": queueFixes };
