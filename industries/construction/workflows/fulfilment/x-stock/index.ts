// The stock workflow's three crons. Each reads and drafts; none sends, authorises or changes a live record.
// Stock on hand and supplier bills come from Xero; reorder rules and supplier emails come from settings.
import type { Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { type BillMatch, type Request, type Settings, money, validLine, validRule } from "./types.ts";
import { xero, awardAct, guid } from "./adapters/xero.ts";

const requestKey = (code: string) => safeKey(`stock:${code}`);

/** Hourly: reads stock on hand and raises a request for each reordered item at or below its level.
 *  An item back above its level closes its open request. */
export async function stockLevels(ctx: Ctx<Settings>) {
  const now = ctx.now.toISOString();
  let raised = 0, closed = 0;
  for (const item of await xero.stockOnHand(ctx)) {
    const rule = ctx.settings.reorder?.[item.code];
    if (!rule || !validRule(rule)) continue;
    const key = requestKey(item.code);
    const cur = await ctx.store.get<Request>("requests", key);
    if (item.onHand > rule.level) {
      if (cur && ["new", "drafted", "awarded"].includes(cur.status)) {
        await ctx.store.put("requests", key, { ...cur, status: "closed", reason: "stock back above its reorder level", updated: now });
        closed++;
      }
      continue;
    }
    if (cur && cur.status !== "closed") continue;   // already requested, drafted, awarded, or skipped for a person to clear
    await ctx.store.put("requests", key, {
      key, code: item.code, name: item.name, on_hand: item.onHand, level: rule.level, qty: rule.order_qty,
      unitPrice: item.unitPrice, supplier_email: rule.supplier_email, ...(rule.supplier_name ? { supplier_name: rule.supplier_name } : {}),
      status: "new", created: now, updated: now,
    } satisfies Request);
    raised++;
  }
  ctx.log(`stock-levels: ${raised} raised, ${closed} closed`);
  return { raised, closed };
}

/** Every 30 minutes: drafts a DRAFT purchase order in Xero for each new request and queues its award for approval.
 *  A request that cannot be drafted is skipped with a reason. A request whose award has run is marked awarded. */
export async function poDraft(ctx: Ctx<Settings>) {
  const now = ctx.now.toISOString();
  let drafted = 0, skipped = 0, awarded = 0;
  for (const r of Object.values(await ctx.store.list<Request>("requests"))) {
    if (r.status === "drafted" && r.approval) {
      const ap = await ctx.store.get<Approval>("approvals", r.approval);
      if (ap?.status === "done") { await ctx.store.put("requests", r.key, { ...r, status: "awarded", updated: now }); awarded++; }
      else if (ap?.status === "rejected") {
        await ctx.store.put("requests", r.key, { ...r, status: "skipped", reason: "award rejected; clear this request by hand", updated: now });
        skipped++;
      }
      continue;
    }
    if (r.status !== "new") continue;
    const skip = async (reason: string) => {
      skipped++;
      await ctx.store.put("requests", r.key, { ...r, status: "skipped", reason, updated: now });
    };
    if (!validLine(r)) { await skip("no unit price in Xero, or the line is out of range"); continue; }
    const contact = await xero.contactByEmail(ctx, r.supplier_email);
    if (!contact) { await skip(`no Xero contact with the email ${r.supplier_email}`); continue; }
    const po = await xero.draftPo(ctx, r, contact);
    const label = po.number ?? po.id;
    const approval = await ctx.queue(awardAct(po.id, label, `award:${r.key}`),
      `award PO ${label}: ${r.qty} x ${r.code} at ${money(Number(r.unitPrice))} each ex GST, to ${r.supplier_name ?? r.supplier_email}`);
    await ctx.store.put("requests", r.key, { ...r, status: "drafted", po, approval, updated: now });
    drafted++;
  }
  ctx.log(`po-draft: ${drafted} drafted, ${skipped} skipped, ${awarded} awarded`);
  return { drafted, skipped, awarded };
}

/** Daily: matches each supplier bill to an authorised purchase order from the same supplier and logs the result. Reads only. */
export async function billMatch(ctx: Ctx<Settings>) {
  const orders = await xero.openOrders(ctx);
  const counts = { matched: 0, differs: 0, over: 0, "no-order": 0 };
  for (const b of await xero.bills(ctx)) {
    let invoice: string;
    try { invoice = guid(b.InvoiceID); } catch { continue; }
    const total = Number(b.Total), supplier = b.Contact?.ContactID;
    if (!Number.isFinite(total) || !supplier) continue;
    const same = orders.filter((o) => o.Contact?.ContactID === supplier);
    const exact = same.find((o) => Math.abs(Number(o.Total) - total) < 0.005);
    const biggest = same.reduce((m, o) => Math.max(m, Number(o.Total) || 0), 0);
    const status: BillMatch["status"] = exact ? "matched" : same.length === 0 ? "no-order" : total > biggest + 0.005 ? "over" : "differs";
    counts[status]++;
    await ctx.store.put("bills", safeKey(`bill:${invoice}`), {
      invoice, total, status, ...(exact?.PurchaseOrderNumber ? { po: String(exact.PurchaseOrderNumber).slice(0, 60) } : {}), checked: ctx.now.toISOString(),
    } satisfies BillMatch);
  }
  ctx.log(`bill-match: ${JSON.stringify(counts)}`);
  return counts;
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "stock-levels": stockLevels,
  "po-draft": poDraft,
  "bill-match": billMatch,
};
