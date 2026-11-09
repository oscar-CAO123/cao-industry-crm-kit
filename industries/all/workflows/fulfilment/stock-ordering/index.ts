// The stock-ordering workflow's three crons. Each reads, drafts or queues. A purchase order reaches a supplier only
// after a person approves its authorisation in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Stock, type Reorder, checkRules, day, keyOf, money, str } from "./types.ts";
import { type Approval, approvalId } from "../../../../../core/workflows/runtime.ts";
import { readItems, createDraftPo, authoriseAct, readPo } from "./adapters/xero.ts";

const DAY = 864e5;
const P = "xero";

/** Every 2 hours: read stock on hand for each item the owner reorders, and store it. */
export async function stockCheck(ctx: Ctx<Settings>) {
  const rules = checkRules(ctx.settings);
  const byCode = new Map((await readItems(ctx)).map((i) => [String(i.Code ?? ""), i]));
  const missing: string[] = [];
  for (const r of rules) {
    const it = byCode.get(r.code);
    const onHand = Number(it?.QuantityOnHand), cost = Number(it?.PurchaseDetails?.UnitPrice);
    if (!it || !Number.isFinite(onHand) || onHand < 0) { missing.push(r.code); continue; }
    await ctx.store.put("stock", keyOf(r.code), { code: r.code, item_id: str(it.ItemID, 60), name: str(it.Name, 200), on_hand: onHand,
      unit_cost: Number.isFinite(cost) && cost >= 0 ? cost : null, checked: ctx.now.toISOString() } satisfies Stock);
  }
  if (missing.length) ctx.log(`stock-check: not tracked as inventory in Xero, not checked: ${missing.join(", ")}`);
  ctx.log(`stock-check: ${rules.length - missing.length} items stored`);
  return { stored: rules.length - missing.length, missing };
}

/** Every hour: an item at or below its minimum gets a DRAFT purchase order in Xero, and its authorisation is queued for approval. */
export async function reorderDraft(ctx: Ctx<Settings>) {
  const rules = checkRules(ctx.settings);
  const authorise = (o: Reorder) => {
    const summary = `Authorise Xero purchase order for ${o.qty} x ${o.code} (${money(Math.round(o.qty * o.unit_cost * 100) / 100)} ex GST) so it can go to the supplier`;
    return ctx.queue(authoriseAct(o.po_id, summary), summary);
  };
  // Re-queue any order still waiting; queue() returns the existing approval, so this never doubles up.
  // A rejected authorisation closes its order, so the item can be drafted again (the Xero draft stays unauthorised).
  const all = Object.values(await ctx.store.list<Reorder>("reorders"));
  for (const o of all) {
    if (o.stage !== "awaiting-approval") continue;
    const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `authorise:${o.po_id}`));
    if (ap?.status === "rejected") {
      o.stage = "closed"; o.checked = ctx.now.toISOString();
      await ctx.store.put("reorders", o.key, o);
      ctx.log(`reorder-draft: ${o.code} authorisation rejected, order closed`);
      continue;
    }
    await authorise(o);
  }
  const open = all.filter((o) => o.stage !== "closed");
  let drafted = 0;
  for (const r of rules) {
    const s = await ctx.store.get<Stock>("stock", keyOf(r.code));
    if (!s || s.on_hand > r.min) continue;
    if (open.some((o) => o.code === r.code)) continue;             // an open order already covers this item
    if (s.unit_cost === null) { ctx.log(`reorder-draft: ${r.code} has no purchase price in Xero, not drafted`); continue; }
    const key = keyOf(`${r.code}:${day(ctx.now)}`);
    if (await ctx.store.get("reorders", key)) continue;            // already drafted today
    const qty = Math.ceil(r.max - s.on_hand);
    const delivery = new Date(ctx.now.getTime() + (ctx.settings.delivery_days ?? 14) * DAY);
    const poId = await createDraftPo(ctx, { code: r.code, name: s.name, qty, unit_cost: s.unit_cost, supplier: r.supplier, delivery, key });
    const rec: Reorder = { key, code: r.code, qty, unit_cost: s.unit_cost, po_id: poId, stage: "awaiting-approval", po_status: "DRAFT",
      created: ctx.now.toISOString(), expected: day(delivery), overdue: false };
    await ctx.store.put("reorders", key, rec);
    open.push(rec);
    await authorise(rec);
    drafted++;
  }
  ctx.log(`reorder-draft: ${drafted} drafted`);
  return { drafted };
}

/** Daily: read each open purchase order's status in Xero, flag the ones past their delivery date, and close the billed or deleted ones. */
export async function poCheck(ctx: Ctx<Settings>) {
  const open = Object.values(await ctx.store.list<Reorder>("reorders")).filter((o) => o.stage !== "closed");
  let closed = 0, overdue = 0;
  for (const o of open) {
    const status = await readPo(ctx, o.po_id);
    if (!status) continue;
    o.po_status = status;
    if (status === "BILLED" || status === "DELETED") { o.stage = "closed"; closed++; }
    else if (status === "AUTHORISED") o.stage = "authorised";
    o.overdue = o.stage === "authorised" && day(ctx.now) > o.expected;
    if (o.overdue) overdue++;
    o.checked = ctx.now.toISOString();
    await ctx.store.put("reorders", o.key, o);
  }
  ctx.log(`po-check: ${open.length} open, ${closed} closed, ${overdue} overdue`);
  return { checked: open.length, closed, overdue };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = {
  "stock-check": stockCheck, "reorder-draft": reorderDraft, "po-check": poCheck,
};
