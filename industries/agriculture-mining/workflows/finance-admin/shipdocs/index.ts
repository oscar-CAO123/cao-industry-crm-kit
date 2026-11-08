// The export document check's three crons. Each reads and drafts, or queues a live step for a person to approve.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, Shipment } from "./types.ts";
import { EMAIL, checkLines, shipTotal } from "./types.ts";
import { draftInvoice, compareInvoice, sendActs } from "./adapters/xero.ts";

const shipments = async (ctx: Ctx<Settings>, want: Shipment["status"][]) =>
  Object.values(await ctx.store.list<Shipment>("shipments")).filter((s) => want.includes(s.status));
const reasonOf = (e: unknown) => String((e as any)?.message ?? e).slice(0, 120);

/** Every 30 minutes: a new shipment record gets a DRAFT commercial invoice in Xero. Records without usable lines wait for details. */
export async function draft(ctx: Ctx<Settings>) {
  let drafted = 0, waiting = 0;
  for (const s of await shipments(ctx, ["new", "needs-details"])) {
    const got = checkLines(s.lines);
    if ("reason" in got) { waiting++; await ctx.store.put("shipments", s.id, { ...s, status: "needs-details", reason: got.reason }); continue; }
    try {
      const invoice_id = await draftInvoice(ctx, { ...s, lines: got.lines });
      await ctx.store.put("shipments", s.id, { ...s, lines: got.lines, status: "drafted", invoice_id, reason: undefined });
      drafted++;
    } catch (e) {
      waiting++;
      await ctx.store.put("shipments", s.id, { ...s, status: "needs-details", reason: `draft failed: ${reasonOf(e)}` });
    }
  }
  ctx.log(`draft: ${drafted} drafted, ${waiting} waiting`);
  return { drafted, waiting };
}

/** Every hour: compare each drafted invoice with its shipment record. A problem is flagged for a person; Xero is not changed. */
export async function crossCheck(ctx: Ctx<Settings>) {
  let ok = 0, flagged = 0;
  for (const s of await shipments(ctx, ["drafted", "checked", "mismatch"])) {
    try {
      const problem = await compareInvoice(ctx, s);
      if (problem) { flagged++; await ctx.store.put("shipments", s.id, { ...s, status: "mismatch", reason: problem }); }
      else { ok++; await ctx.store.put("shipments", s.id, { ...s, status: "checked", reason: undefined, checked_at: ctx.now.toISOString() }); }
    } catch (e) {
      flagged++;
      await ctx.store.put("shipments", s.id, { ...s, status: "mismatch", reason: `cross-check failed: ${reasonOf(e)}` });
    }
  }
  ctx.log(`cross-check: ${ok} match, ${flagged} flagged`);
  return { ok, flagged };
}

/** Every 30 minutes: an approved, checked shipment gets its authorise-and-email step queued. Only a person's approval sends it. */
export async function send(ctx: Ctx<Settings>) {
  let queued = 0;
  for (const s of await shipments(ctx, ["approved"])) {
    if (!s.checked_at || !s.invoice_id) continue;
    if (!s.buyer.email || !EMAIL.test(s.buyer.email)) {
      await ctx.store.put("shipments", s.id, { ...s, reason: "no valid buyer email: add it before approval" });
      continue;
    }
    const acts = sendActs(s);
    await ctx.queue(acts, `Authorise and email invoice for ${s.title} (${shipTotal(s.lines).toFixed(2)} ex GST) to ${s.buyer.email}`);
    await ctx.store.put("shipments", s.id, { ...s, status: "queued", reason: undefined });
    queued++;
  }
  ctx.log(`send: ${queued} queued for approval`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { draft, "cross-check": crossCheck, send };
