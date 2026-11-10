// The variations workflow's three crons. Each is deterministic: it reads, drafts and queues; it never sends.
// Judgment (reading site notes or photos, choosing lines for work with no template) belongs to the agent skill in
// SKILL.md, which writes a proposal into the store; the draft cron checks it against the rate card.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import type { Enquiry, Line, Settings, Variation } from "./types.ts";
import { servicem8 } from "./adapters/servicem8.ts";
import * as pc from "./adapters/procore.ts";

type Tracked = { number: string; title: string; status: string; project: string; first: string; stale_logged?: string };

/** A business sets one system: the ServiceM8 flow (variation_words, templates, follow-ups) or procore. Both together are refused. */
function procoreOnly(ctx: Ctx<Settings>): boolean {
  const s = ctx.settings;
  if (!s.procore) return false;
  if (s.variation_words || s.variation_templates || s.follow_up) throw new Error("variations: set either the ServiceM8 variation settings or procore, not both");
  return true;
}

const DAY = 864e5;

/** Every 15 minutes: notes on accepted jobs that say the client has extra work. */
export async function intake(ctx: Ctx<Settings>) {
  if (procoreOnly(ctx)) {
    // Procore: each change event is recorded once. Pricing and approval stay in Procore, so nothing here is drafted or sent.
    let added = 0;
    for (const p of pc.projects(ctx)) for (const c of await pc.changeEvents(ctx, p.id)) {
      const key = `${p.id}:${c.id}`;
      const was = await ctx.store.get<Tracked>("procoreChanges", key);
      if (!was) { await ctx.store.put("procoreChanges", key, { number: c.number, title: c.title, status: c.status, project: p.name, first: ctx.now.toISOString() } satisfies Tracked); added++; if (c.open) ctx.log(`intake: new open change event ${c.number} "${c.title}" on ${p.name}`); }
      else if (was.status !== c.status) await ctx.store.put("procoreChanges", key, { ...was, status: c.status, ...(c.open ? {} : { stale_logged: undefined }) });
    }
    ctx.log(`intake: ${added} new change events (Procore)`);
    return { added };
  }
  let added = 0;
  for (const n of await servicem8.notes(ctx)) {
    if (await ctx.store.get("enquiries", n.id)) continue;
    await ctx.store.put("enquiries", n.id, { ...n, status: "new" } satisfies Enquiry);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 30 minutes: price each new variation from the rate card and queue the client email for approval. */
export async function draft(ctx: Ctx<Settings>) {
  if (procoreOnly(ctx)) { ctx.log("draft: Procore holds the pricing and approval; nothing to draft"); return { drafted: 0, needs_pricing: 0 }; }
  const todo = Object.values(await ctx.store.list<Enquiry>("enquiries")).filter((e) => e.status === "new" || e.status === "needs-pricing");
  if (!todo.length) return { drafted: 0, needs_pricing: 0 };
  const rate = await servicem8.rateCard(ctx);
  const byCode = new Map(rate.map((r) => [r.code.toLowerCase(), r]));
  let drafted = 0, pending = 0;
  for (const e of todo) {
    const prop = await ctx.store.get<{ lines: { code: string; qty: number; unitPrice?: number }[] }>("proposals", e.id);
    const text = `${e.title} ${e.text ?? ""}`.toLowerCase();
    const tpl = (ctx.settings.variation_templates ?? []).find((t) => t.match && text.includes(t.match.toLowerCase()));
    const want: { code: string; qty: number; unitPrice?: number }[] | undefined = prop?.lines ?? tpl?.lines;
    const park = async (reason: string) => { pending++; await ctx.store.put("enquiries", e.id, { ...e, status: "needs-pricing", reason }); };
    if (!want?.length) { await park("no variation template matches and no proposal yet: the agent skill prices it"); continue; }
    const lines: Line[] = [], bad: string[] = [];
    for (const w of want) {
      const r = byCode.get(String(w.code).toLowerCase()), qty = Number(w.qty);
      if (!r || !(qty > 0) || qty > 100000) { bad.push(String(w.code)); continue; }
      const unit = prop && typeof w.unitPrice === "number" && w.unitPrice >= 0 ? w.unitPrice : r.price;
      lines.push({ code: r.code, name: r.name, qty, unitPrice: unit });
    }
    if (bad.length) { await park(`not on the rate card or bad quantity: ${bad.slice(0, 5).join(", ")}`); continue; }
    const fresh = (await ctx.store.get<Enquiry>("enquiries", e.id)) ?? e; // the adapter may have recorded the job note on it
    const priced = !!prop && want.some((w) => typeof w.unitPrice === "number");
    const v = await servicem8.draftVariation(ctx, fresh, lines, priced);
    await ctx.store.put("variations", v.key, v);
    const after = (await ctx.store.get<Enquiry>("enquiries", e.id)) ?? fresh;
    await ctx.store.put("enquiries", e.id, { ...after, status: "drafted", variation: v.key, reason: undefined });
    drafted++;
  }
  ctx.log(`draft: ${drafted} drafted, ${pending} need pricing`);
  return { drafted, needs_pricing: pending };
}

/** Daily: learn which variation emails were approved, then queue follow-ups that are due. */
export async function followUp(ctx: Ctx<Settings>) {
  if (procoreOnly(ctx)) {
    // Procore: log each change event still open past the window, once. The chase itself is a person in Procore; no message is queued.
    const days = ctx.settings.procore?.stale_after_days ?? 14;
    let stale = 0;
    for (const [key, c] of Object.entries(await ctx.store.list<Tracked>("procoreChanges"))) {
      if (c.status.toLowerCase() !== "open" || c.stale_logged || ctx.now.getTime() - Date.parse(c.first) < days * DAY) continue;
      await ctx.store.put("procoreChanges", key, { ...c, stale_logged: ctx.now.toISOString() });
      ctx.log(`follow-up: change event ${c.number} "${c.title}" on ${c.project} has been open ${days} days or more`);
      stale++;
    }
    return { queued: 0, stale };
  }
  const vars = await ctx.store.list<Variation>("variations");
  const days = ctx.settings.follow_up?.after_days ?? [3, 7];
  for (const v of Object.values(vars)) {
    if (v.status !== "draft") continue;
    const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `send:${v.key}`));
    // Sent once the email itself succeeded, even if a later act in the bundle failed.
    if (ap && (ap.status === "done" || (ap.results?.[0]?.status ?? 999) < 300)) { v.status = "sent"; v.sent_at = ap.started ?? ap.decided; }
  }
  let queued = 0;
  for (const v of Object.values(vars)) {
    if (v.status !== "sent" || !v.sent_at) continue;
    const n = v.followups?.length ?? 0;
    if (n >= days.length || ctx.now.getTime() - Date.parse(v.sent_at) < days[n] * DAY) continue;
    const id = await servicem8.followUp(ctx, v, n + 1);
    if (id) { v.followups = [...(v.followups ?? []), ctx.now.toISOString()]; queued++; }
  }
  for (const v of Object.values(vars)) await ctx.store.put("variations", v.key, v);
  ctx.log(`follow-up: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, draft, "follow-up": followUp };
