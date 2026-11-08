// The supplier RFQ workflow's four crons. Each reads, drafts or queues. None sends: every send, every chaser send and
// every authorised purchase order waits in the approval queue for a person.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Rfq, Settings } from "./types.ts";
import { RFQ_ID, EMAIL, day } from "./types.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";
import { xero } from "./adapters/xero.ts";

const DAY = 864e5;
const rfqs = async (ctx: Ctx<Settings>) => Object.values(await ctx.store.list<Rfq>("rfqs")).filter((r) => RFQ_ID.test(r.id));
const save = (ctx: Ctx<Settings>, r: Rfq) => ctx.store.put("rfqs", r.id, r);
const validSuppliers = (r: Rfq) => r.suppliers.filter((s) => EMAIL.test(s.email));

/** Every 15 minutes: one RFQ draft per supplier, each send queued for approval, the issue logged to the register. */
export async function issue(ctx: Ctx<Settings>) {
  let queued = 0;
  for (const rfq of (await rfqs(ctx)).filter((r) => r.status === "new")) {
    const suppliers = validSuppliers(rfq);
    if (!suppliers.length) { ctx.log(`issue: RFQ ${rfq.id} has no valid supplier email, skipped`); continue; }
    const sent = new Set(rfq.sent ?? []);
    rfq.drafts ??= {};
    for (const s of suppliers) {
      if (sent.has(s.email)) continue;
      if (!rfq.drafts[s.email]) {                     // draft once; a re-run reuses the draft instead of making another
        rfq.drafts[s.email] = await microsoft365.draftRfq(ctx, rfq, s);
        await save(ctx, rfq);
        await microsoft365.logRow(ctx, [day(ctx.now), rfq.id, s.name, s.email, "RFQ drafted", rfq.title]);
      }
      await ctx.queue(microsoft365.sendAct(ctx, rfq.drafts[s.email], s.email, `send:${rfq.id}:${s.email}`, `send RFQ ${rfq.id} to ${s.email}`));
      sent.add(s.email);
      rfq.sent = [...sent];
      await save(ctx, rfq);
      queued++;
    }
    if (suppliers.every((s) => sent.has(s.email))) { rfq.status = "issued"; rfq.issued_at = ctx.now.toISOString(); await save(ctx, rfq); }
  }
  ctx.log(`issue: ${queued} sends queued for approval`);
  return { queued };
}

/** Daily: for each open RFQ that is due, one chaser draft per supplier who has not replied, each send queued for approval. */
export async function chase(ctx: Ctx<Settings>) {
  const days = ctx.settings.chase_after_days ?? [3, 7];
  let queued = 0;
  for (const rfq of (await rfqs(ctx)).filter((r) => r.status === "issued" && r.issued_at)) {
    const n = rfq.chases ?? 0;
    if (n >= days.length || ctx.now.getTime() - Date.parse(rfq.issued_at!) < days[n] * DAY) continue;
    const round = n + 1;
    const replied = new Set(rfq.replied ?? []);
    rfq.chase_drafts ??= {};
    for (const s of validSuppliers(rfq).filter((x) => !replied.has(x.email.toLowerCase()))) {
      const k = `${round}:${s.email.toLowerCase()}`;
      if (!rfq.chase_drafts[k]) { rfq.chase_drafts[k] = await microsoft365.draftChase(ctx, rfq, s, round); await save(ctx, rfq); }
      await ctx.queue(microsoft365.sendAct(ctx, rfq.chase_drafts[k], s.email, `chase${round}:${rfq.id}:${s.email.toLowerCase()}`, `chaser ${round} for RFQ ${rfq.id} to ${s.email}`));
      queued++;
    }
    rfq.chases = round;
    await save(ctx, rfq);
  }
  ctx.log(`chase: ${queued} chasers queued for approval`);
  return { queued };
}

/** Every 30 minutes: log each new supplier reply to an open RFQ in the register and mark that supplier as replied.
 *  Prices are read from the reply by a person or the agent skill, never parsed or guessed here. */
export async function replies(ctx: Ctx<Settings>) {
  const open = (await rfqs(ctx)).filter((r) => r.status === "issued");
  if (!open.length) return { logged: 0 };
  let logged = 0;
  for (const m of await microsoft365.replies(ctx)) {
    const rfq = open.find((r) => new RegExp(`(^|[^A-Za-z0-9_-])RFQ ${r.id}($|[^A-Za-z0-9_-])`, "i").test(m.subject));
    if (!rfq) continue;
    const s = rfq.suppliers.find((x) => x.email.toLowerCase() === m.email);
    if (!s || (rfq.reply_ids ?? []).includes(m.id)) continue;
    await microsoft365.logRow(ctx, [day(ctx.now), rfq.id, s.name, s.email, "Reply", m.preview.slice(0, 200)]);
    rfq.reply_ids = [...(rfq.reply_ids ?? []), m.id];
    rfq.replied = [...new Set([...(rfq.replied ?? []), s.email.toLowerCase()])];
    await save(ctx, rfq);
    logged++;
  }
  ctx.log(`replies: ${logged} logged`);
  return { logged };
}

/** Hourly: an awarded RFQ becomes a draft purchase order in Xero, and its move to AUTHORISED is queued for approval. */
export async function purchaseOrder(ctx: Ctx<Settings>) {
  let drafted = 0, queued = 0;
  for (const rfq of (await rfqs(ctx)).filter((r) => r.award)) {
    try {
      if (!rfq.po) {
        const id = await xero.draftPurchaseOrder(ctx, rfq);
        rfq.po = { id, drafted: ctx.now.toISOString() };
        await save(ctx, rfq);
        drafted++;
      }
      await ctx.queue(xero.authoriseAct(rfq.po!.id, rfq.id));
      queued++;
    } catch (e: any) {
      ctx.log(`purchase-order: RFQ ${rfq.id} skipped: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  ctx.log(`purchase-order: ${drafted} drafted, ${queued} authorise queued`);
  return { drafted, queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { issue, chase, replies, "purchase-order": purchaseOrder };
