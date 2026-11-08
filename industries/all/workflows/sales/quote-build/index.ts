// The quote-build workflow's four crons. Each is deterministic: it reads, drafts and queues; it never sends.
// Judgment (reading notes, photos or plans, choosing lines for a job with no template, setting a margin) belongs to the
// agent skill in SKILL.md, which writes a proposal into the store; the draft cron checks it against the rate card.
// The platform adapters are the construction quoting ones, reused by relative import and not edited here.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { servicem8 } from "../../../../../industries/construction/workflows/sales/quoting/adapters/servicem8.ts";
import { xero, draftInvoice } from "../../../../../industries/construction/workflows/sales/quoting/adapters/xero.ts";
import { microsoft365 } from "../../../../../industries/construction/workflows/sales/quoting/adapters/microsoft-365.ts";
import { reuse, type Adapter, type Enquiry, type Line, type Platform, type Quote, type Settings } from "./types.ts";

export const ADAPTERS: Record<Platform, Adapter> = { servicem8, xero, "microsoft-365": microsoft365 };
const adapter = (p: Platform, need: keyof Adapter) => {
  const a = ADAPTERS[p];
  if (!a || !a[need]) throw new Error(`quote-build: ${p} cannot ${need}`);
  return a;
};
const DAY = 864e5;

/** Every 10 minutes: new quote requests from each intake source. */
export async function intake(ctx: Ctx<Settings>) {
  let added = 0;
  for (const p of ctx.settings.intake) {
    for (const e of await adapter(p, "enquiries").enquiries!(reuse(ctx))) {
      if (await ctx.store.get("enquiries", e.id)) continue;
      await ctx.store.put("enquiries", e.id, { ...e, status: "new" } satisfies Enquiry);
      added++;
    }
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: price each new request from the rate card and draft the quote; queue its send for approval. */
export async function draft(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => e.status === "new" || e.status === "needs-pricing");
  if (!todo.length) return { drafted: 0, needs_pricing: 0 };
  const rate = await adapter(ctx.settings.rate_card, "rateCard").rateCard!(reuse(ctx));
  const byCode = new Map(rate.map((r) => [r.code.toLowerCase(), r]));
  let drafted = 0, pending = 0;
  for (const e of todo) {
    const prop = await ctx.store.get<{ lines: { code: string; qty: number; unitPrice?: number }[] }>("proposals", e.id);
    const text = `${e.title} ${e.text ?? ""}`.toLowerCase();
    const tpl = (ctx.settings.job_templates ?? []).find((t) => t.match && text.includes(t.match.toLowerCase()));
    const want = prop?.lines ?? tpl?.lines;
    const park = async (reason: string) => { pending++; await ctx.store.put("enquiries", e.id, { ...e, status: "needs-pricing", reason }); };
    if (!want?.length) { await park("no job template matches and no proposal yet: the agent skill prices it"); continue; }
    const lines: Line[] = [], bad: string[] = [];
    for (const w of want) {
      const r = byCode.get(String(w.code).toLowerCase()), qty = Number(w.qty);
      if (!r || !(qty > 0) || qty > 100000) { bad.push(String(w.code)); continue; }
      const unit = prop && typeof w.unitPrice === "number" && w.unitPrice >= 0 ? w.unitPrice : r.price;
      lines.push({ code: r.code, name: r.name, qty, unitPrice: unit, ref: r.ref });
    }
    if (bad.length) { await park(`not on the rate card or bad quantity: ${bad.slice(0, 5).join(", ")}`); continue; }
    const fresh = (await ctx.store.get<Enquiry>("enquiries", e.id)) ?? e; // an adapter may have recorded a created record on it
    const priced = !!prop && want.some((w: any) => typeof w.unitPrice === "number");
    const q = await adapter(ctx.settings.quotes, "draftQuote").draftQuote!(reuse(ctx), { ...fresh, priced_by_proposal: priced } as Enquiry, lines);
    await ctx.store.put("quotes", q.key, q);
    const after = (await ctx.store.get<Enquiry>("enquiries", e.id)) ?? fresh;
    await ctx.store.put("enquiries", e.id, { ...after, status: "drafted", quote: q.key, reason: undefined });
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${pending} need pricing`);
  return { drafted, needs_pricing: pending };
}

/** Daily: learn which sends were approved, refresh status from the platform, queue follow-ups that are due. */
export async function followUp(ctx: Ctx<Settings>) {
  const quotes = await ctx.store.list<Quote>("quotes");
  const days = ctx.settings.follow_up?.after_days ?? [3, 7, 14];
  let queued = 0;
  for (const q of Object.values(quotes)) {
    if (q.status === "draft") {
      const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `send:${q.key}`));
      // Sent once the first act (the send itself) succeeded, even if a later act in the bundle failed.
      if (ap && (ap.status === "done" || (ap.results?.[0]?.status ?? 999) < 300)) { q.status = "sent"; q.sent_at = ap.started ?? ap.decided; }
    }
  }
  const open = Object.values(quotes).filter((q) => q.status === "sent");
  for (const p of new Set(open.map((q) => q.platform))) {
    const a = ADAPTERS[p];
    if (a.refresh) await a.refresh(reuse(ctx), open.filter((q) => q.platform === p));
  }
  for (const q of open) {
    if (q.status !== "sent" || !q.sent_at) continue;
    const n = q.followups?.length ?? 0;
    if (n >= days.length || ctx.now.getTime() - Date.parse(q.sent_at) < days[n] * DAY) continue;
    const id = await adapter(q.platform, "followUp").followUp!(reuse(ctx), q, n + 1);
    if (id) { q.followups = [...(q.followups ?? []), ctx.now.toISOString()]; queued++; }
  }
  for (const q of Object.values(quotes)) await ctx.store.put("quotes", q.key, q);
  ctx.log(`follow-up: ${queued} queued`);
  return { queued };
}

/** Hourly: an accepted quote becomes a draft invoice in Xero (or nothing, when the platform sets up the job itself). */
export async function handover(ctx: Ctx<Settings>) {
  let done = 0;
  const all = Object.values(await ctx.store.list<Quote>("quotes"));
  for (const p of new Set(all.filter((q) => q.status === "sent").map((q) => q.platform))) {   // acceptance checked hourly
    const a = ADAPTERS[p], open = all.filter((q) => q.status === "sent" && q.platform === p);
    if (a.refresh) { await a.refresh(reuse(ctx), open); for (const q of open) await ctx.store.put("quotes", q.key, q); }
  }
  for (const q of all) {
    if (q.status !== "accepted" || q.handed_over) continue;
    if (ctx.settings.handover?.on_accept === "xero-invoice-draft") q.ref.invoice_id = await draftInvoice(reuse(ctx), q);
    q.handed_over = ctx.now.toISOString();
    await ctx.store.put("quotes", q.key, q);
    done++;
  }
  ctx.log(`handover: ${done} handed over`);
  return { handed_over: done };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, "follow-up": followUp, handover };
