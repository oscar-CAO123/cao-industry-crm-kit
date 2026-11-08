// The deal-structuring workflow's three crons. Each reads, drafts and queues; it never sends and never moves a deal.
// Judgment (choosing lenders, checking the credit application, recording a decision) belongs to the agent skill in
// SKILL.md, which writes a proposal into the store; the draft cron only acts on a proposal someone has marked credit_ready.
import type { Approval } from "../../../../../core/workflows/runtime.ts";
import { approvalId } from "../../../../../core/workflows/runtime.ts";
import { type Cx, type Deal, type Lender, type Proposal, DAY, esc, money, cap } from "./types.ts";
import { openDeals, addNote, stageAct, packNote } from "./adapters/pipedrive.ts";
import { mailDraft, registerRow } from "./adapters/microsoft-365.ts";

/** Every 10 minutes: new deals in the intake stage. */
export async function intake(ctx: Cx) {
  let added = 0;
  for (const d of await openDeals(ctx)) {
    const id = String(d.id);
    if (await ctx.store.get("deals", id)) continue;
    await ctx.store.put("deals", id, { id, title: cap(d.title ?? "Deal", 200), value: d.value, currency: d.currency,
      person_id: d.person_id, org_id: d.org_id, status: "new", seen: ctx.now.toISOString() } satisfies Deal);
    added++;
  }
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 15 minutes: for each deal whose proposal is marked credit_ready, draft one lender pack per lender and queue each send. */
export async function draft(ctx: Cx) {
  const todo = Object.values(await ctx.store.list<Deal>("deals")).filter((d) => d.status === "new");
  let packed = 0, parked = 0;
  for (const d of todo) {
    const prop = await ctx.store.get<Proposal>("proposals", d.id);
    if (!prop?.credit_ready) continue;
    const limit = ctx.settings.max_lenders_per_deal ?? 3;
    const lenders = (prop.lenders ?? []).map((id) => ctx.settings.lenders.find((l) => l.id === id)).filter((l): l is Lender => !!l).slice(0, limit);
    if (!lenders.length) {
      parked++;
      await ctx.store.put("deals", d.id, { ...d, reason: "no lender in settings matches the proposal" });
      continue;
    }
    const fresh = (await ctx.store.get<Deal>("deals", d.id)) ?? d;
    const packs = { ...(fresh.packs ?? {}) };
    for (const l of lenders) {
      if (packs[l.id]) continue;                       // already drafted: a re-run never drafts or queues twice
      const amount = prop.amount_financed ? money(prop.amount_financed) : "to be confirmed";
      const m = await mailDraft(ctx, { to: l.submit_to, subject: `Finance application: ${fresh.title}`,
        html: `<p>Hi ${esc(l.name)},</p><p>Please find a finance application for ${esc(fresh.title)}. Amount financed: ${esc(amount)}, term: ${esc(prop.term_months ?? "to be confirmed")} months.</p>${prop.note ? `<p>${esc(prop.note)}</p>` : ""}` });
      const approval = await ctx.queue([{ ...m.act, key: `submit:${fresh.id}:${l.id}` }, stageAct(ctx, Number(fresh.id))],
        `Send finance application for ${fresh.title} to ${l.name}, then move the deal to lender submitted`);
      packs[l.id] = { message_id: m.messageId, approval };
      await ctx.store.put("deals", fresh.id, { ...fresh, packs });
    }
    if (!fresh.noted) await addNote(ctx, Number(fresh.id), packNote(lenders.map((l) => l.name)));
    await registerRow(ctx, [fresh.id, fresh.title, lenders.map((l) => l.name).join("; "), prop.amount_financed ?? "", "Pack drafted"]);
    await ctx.store.put("deals", fresh.id, { ...fresh, packs, status: "packed", noted: true, reason: undefined });
    packed++;
  }
  ctx.log(`draft: ${packed} packed, ${parked} parked`);
  return { packed, parked };
}

/** Daily: a deal is submitted once its first lender send is approved and done; a chase is queued when a submission
 *  has no decision after the set number of days. */
export async function followUp(ctx: Cx) {
  const days = ctx.settings.follow_up?.after_days ?? [3, 7];
  let queued = 0;
  for (const d of Object.values(await ctx.store.list<Deal>("deals"))) {
    if (d.status === "packed") {
      for (const lid of Object.keys(d.packs ?? {})) {
        const ap = await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, `submit:${d.id}:${lid}`));
        if (ap?.status === "done") { d.status = "submitted"; d.submitted_to = lid; d.submitted_at = ap.decided ?? ctx.now.toISOString(); break; }
      }
    }
    if (d.status === "submitted" && !d.decided && d.submitted_at && d.submitted_to) {
      const n = d.followups?.length ?? 0;
      const lender = ctx.settings.lenders.find((l) => l.id === d.submitted_to);
      if (lender && n < days.length && ctx.now.getTime() - Date.parse(d.submitted_at) >= days[n] * DAY) {
        const m = await mailDraft(ctx, { to: lender.submit_to, subject: `Following up: ${d.title}`,
          html: `<p>Hi ${esc(lender.name)}, just checking you received the finance application for ${esc(d.title)}. Happy to answer any questions.</p>` });
        await ctx.queue({ ...m.act, key: `chase${n + 1}:${d.id}` }, `chase ${lender.name} on ${d.title} (follow-up ${n + 1})`);
        d.followups = [...(d.followups ?? []), ctx.now.toISOString()];
        queued++;
      }
    }
    await ctx.store.put("deals", d.id, d);
  }
  ctx.log(`follow-up: ${queued} queued`);
  return { queued };
}

export const CRONS: Record<string, (ctx: Cx) => Promise<unknown>> = { intake, draft, "follow-up": followUp };
