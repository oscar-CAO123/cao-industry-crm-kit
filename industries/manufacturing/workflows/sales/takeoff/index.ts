// The manufacturing takeoff workflow's two crons. Each is deterministic: it reads, drafts and queues; it never sends.
// Measuring the drawings is the estimator's job (see SKILL.md). The crons price the quantities the estimator enters.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Adapter, type Enquiry, type Line, type Platform, type Settings, MAX_QTY, keyOf } from "./types.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";

export const ADAPTERS: Record<Platform, Adapter> = { "microsoft-365": microsoft365 };
const adapter = (p: string): Adapter => {
  const a = ADAPTERS[p as Platform];
  if (!a) throw new Error(`takeoff: ${p} is not an adapter in this workflow`);
  return a;
};

/** Every 30 minutes: new takeoff requests from each intake source. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const p of ctx.settings.intake) {
    for (const e of await adapter(p).enquiries(ctx)) {
      if (await ctx.store.get("enquiries", e.id)) continue;
      await ctx.store.put("enquiries", e.id, { ...e, status: "new" } satisfies Enquiry);
      added++;
    }
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Hourly: price each open request from the takeoff table and the rate card, draft the quote, queue its send. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => e.status !== "drafted");
  if (!todo.length) return { drafted: 0, parked: 0 };
  const rows = await adapter(ctx.settings.takeoff).takeoff(ctx);
  const rate = await adapter(ctx.settings.rate_card).rateCard(ctx);
  const byCode = new Map(rate.map((r) => [r.code.toLowerCase(), r]));
  let drafted = 0, parked = 0;
  for (const e of todo) {
    const park = async (status: "needs-takeoff" | "needs-pricing", reason: string) => {
      parked++;
      await ctx.store.put("enquiries", e.id, { ...e, status, reason });
    };
    const job = e.ref.job;
    if (!job) { await park("needs-takeoff", "no job reference in the subject"); continue; }
    if (!e.contact.email) { await park("needs-pricing", "no requester email address"); continue; }
    const mine = rows.filter((r) => r.job === job);
    if (!mine.length) { await park("needs-takeoff", `no takeoff rows for ${job} yet`); continue; }
    const lines: Line[] = [], bad: string[] = [];
    for (const m of mine) {
      const r = byCode.get(m.code.toLowerCase());
      if (!r || !(m.qty > 0) || m.qty > MAX_QTY) { bad.push(m.code); continue; }
      lines.push({ code: r.code, name: r.name, qty: m.qty, unitPrice: r.price, ref: r.ref });
    }
    if (bad.length) { await park("needs-pricing", `not on the rate card or bad quantity: ${bad.slice(0, 5).join(", ")}`); continue; }
    // A quote already drafted for this request is never drafted again, even if the request status was reset.
    const qkey = keyOf(`quote:${e.id}`);
    if (await ctx.store.get("quotes", qkey)) { await ctx.store.put("enquiries", e.id, { ...e, status: "drafted", quote: qkey, reason: undefined }); continue; }
    const q = await adapter(ctx.settings.quotes).draftQuote(ctx, e, lines);
    await ctx.store.put("quotes", q.key, q);
    await ctx.store.put("enquiries", e.id, { ...e, status: "drafted", quote: q.key, reason: undefined });
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${parked} parked`);
  return { drafted, parked };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft };
