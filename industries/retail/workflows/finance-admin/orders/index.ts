// The orders workflow's two crons. Each reads, drafts and queues; neither sends. The line proposals are judgment: the agent
// reads the order email and writes them with `node tools/workflow.ts propose <folder> <order-id> <lines.json>`.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Order, type Line, type Settings, EMAIL, clean, money, total } from "./types.ts";
import { gmail } from "./adapters/gmail.ts";
import { xero } from "./adapters/xero.ts";

/** Every 10 minutes: new order emails matching the search in settings. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const e of await gmail.enquiries(ctx)) {
    if (await ctx.store.get("enquiries", e.id)) continue;
    await ctx.store.put("enquiries", e.id, { ...e, status: "new" } satisfies Order);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: enter each order with its proposed lines as a DRAFT Xero invoice, draft the Gmail confirmation, queue its send. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Order>("enquiries")).filter((o) => o.status === "new" || o.status === "needs-lines");
  if (!todo.length) return { drafted: 0, needs_lines: 0 };
  const items = await xero.rateCard(ctx);
  const byCode = new Map(items.map((i) => [i.code.toLowerCase(), i]));
  let drafted = 0, parked = 0;
  for (const o of todo) {
    const park = async (reason: string) => { parked++; await ctx.store.put("enquiries", o.id, { ...o, status: "needs-lines", reason }); };
    if (!o.contact.email || !EMAIL.test(o.contact.email)) { await park("no usable customer email"); continue; }
    const prop = await ctx.store.get<{ lines: { code: string; qty: number; unitPrice?: number }[] }>("proposals", o.id);
    if (!prop?.lines?.length) { await park("no line proposal yet: the agent reads the email and proposes lines"); continue; }
    const lines: Line[] = [], bad: string[] = [];
    for (const w of prop.lines) {
      const it = byCode.get(String(w.code).toLowerCase()), qty = Number(w.qty);
      if (!it || !(qty > 0) || qty > 100000) { bad.push(String(w.code)); continue; }
      lines.push({ code: it.code, name: it.name, qty, unitPrice: typeof w.unitPrice === "number" && w.unitPrice >= 0 ? w.unitPrice : it.price, itemId: it.itemId });
    }
    if (bad.length) { await park(`not on the Xero item list or bad quantity: ${bad.slice(0, 5).join(", ")}`); continue; }
    const invoice = await xero.draftInvoice(ctx, o, lines);
    const draftId = await gmail.confirmation(ctx, o, confirmationText(ctx.settings, o, lines));
    const sum = `Send order confirmation to ${o.contact.email}: ${lines.length} lines, ${money(total(lines))} ex GST`;
    await ctx.queue(gmail.sendAct(o, draftId, sum), sum);
    await ctx.store.put("enquiries", o.id, { ...o, status: "queued", reason: undefined, ref: { ...o.ref, invoice_id: invoice, draft_id: draftId } });
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${parked} need lines`);
  return { drafted, needs_lines: parked };
}

/** Plain text: the customer's name is the only outside text in it, cleaned and short. */
function confirmationText(s: Settings, o: Order, lines: Line[]): string {
  const first = clean(o.contact.name, 60).split(" ")[0] || "there";
  const rows = lines.map((l) => `${l.qty} x ${clean(l.name, 120)}`).join("\n");
  return [`Hi ${first},`, "", "Thanks for your order. We have it and are getting it ready.", "", rows, "",
    `Total ${money(total(lines))} ex GST.`, "", clean(s.business_name, 120) || "Thanks"].join("\n");
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft };
