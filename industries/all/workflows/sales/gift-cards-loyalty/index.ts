// The gift cards and loyalty workflow's three crons. activity and balances read and write internal records only.
// issue queues every card, activation and enrolment for a person to approve. Nothing here sells, takes money or sends.
// Judgment (which sale this is, whether its order is paid, which member to enrol) belongs to the person, in SKILL.md.
import type { Approval, Ctx } from "../../../../../core/workflows/runtime.ts";
import type { LoyaltyMember, Request, Settings } from "./types.ts";
import { DAY, ID, PHONE, checkSettings, dollars, keyOf, validCents, within } from "./types.ts";
import { activities, activateAct, enrolAct, issueCardAct, memberBalance, programIds } from "./adapters/square.ts";

const skip = (ctx: Ctx<Settings>, r: Request, reason: string) =>
  ctx.store.put("requests", r.key, { ...r, status: "skipped", reason } satisfies Request);

/** Settles requests whose approvals have run or been rejected. A rejected request is never queued again. */
async function recordApproved(ctx: Ctx<Settings>): Promise<Request[]> {
  const reqs = Object.values(await ctx.store.list<Request>("requests"));
  for (const r of reqs) {
    let next: Request = r;
    if ((r.status === "issue-queued" || r.status === "enrol-queued") && r.approval) {
      const ap = await ctx.store.get<Approval>("approvals", r.approval);
      const st = ap?.results?.[0]?.status;
      if (ap?.status === "rejected") next = { ...r, status: "skipped", reason: "rejected by a person: not queued again" };
      else if (ap?.status === "done" && typeof st === "number" && st < 300) {
        const id = ap.results?.[0]?.ref?.id;
        if (!id || !ID.test(id)) next = { ...r, status: "skipped", reason: "created in Square but no id came back: check Square before anything else" };
        else if (r.kind === "gift-card") next = { ...r, status: "issued", gift_card_id: id };
        else {
          next = { ...r, status: "enrolled", loyalty_account_id: id };
          await ctx.store.put("loyalty", keyOf(id), { key: keyOf(id), id } satisfies LoyaltyMember);
        }
      }
    } else if (r.status === "activate-queued" && r.activate_approval) {
      const ap = await ctx.store.get<Approval>("approvals", r.activate_approval);
      const st = ap?.results?.[0]?.status;
      if (ap?.status === "rejected") next = { ...r, status: "skipped", reason: "activation rejected by a person: not queued again" };
      else if (ap?.status === "done" && typeof st === "number" && st < 300) next = { ...r, status: "activated" };
    }
    if (next !== r) await ctx.store.put("requests", r.key, next);
  }
  return Object.values(await ctx.store.list<Request>("requests"));
}

/** Every 30 minutes: read gift card activity since the last run (sales, loads, redemptions, refunds) into the ledger. Reads only. */
export async function activity(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const s = ctx.settings;
  const cursor = await ctx.store.get<{ at: string }>("state", "activity");
  const since = cursor?.at ?? new Date(ctx.now.getTime() - within(s.activity_days, 1, 90, 7) * DAY).toISOString();
  const { rows, last } = await activities(ctx, since, within(s.max_pages, 1, 50, 10));
  let added = 0;
  const byType: Record<string, number> = {};
  for (const r of rows) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
    if (await ctx.store.get("ledger", keyOf(r.key))) continue;
    await ctx.store.put("ledger", keyOf(r.key), r);
    added++;
  }
  if (last) await ctx.store.put("state", "activity", { at: last });
  ctx.log(`activity: ${rows.length} read, ${added} new`);
  return { read: rows.length, added, by_type: byType };
}

/** Every 6 hours: confirm the loyalty program is still in Square and read each enrolled member's points balance. Reads only. */
export async function balances(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const s = ctx.settings;
  let programFound: boolean | undefined;
  if (s.loyalty_program_id) {
    programFound = (await programIds(ctx)).includes(s.loyalty_program_id);
    if (!programFound) ctx.log(`balances: loyalty program ${s.loyalty_program_id} is not in Square`);
  }
  const members = Object.values(await ctx.store.list<LoyaltyMember>("loyalty")).slice(0, 500);
  for (const m of members) {
    const balance = await memberBalance(ctx, m.id);
    await ctx.store.put("loyalty", m.key, { ...m, balance, checked_at: ctx.now.toISOString() } satisfies LoyaltyMember);
  }
  ctx.log(`balances: ${members.length} members read`);
  return { program_found: programFound, read: members.length };
}

/** Every 15 minutes: record what a person approved, then queue new cards, paid activations and enrolments for approval. Queues only. */
export async function issue(ctx: Ctx<Settings>) {
  checkSettings(ctx.settings);
  const s = ctx.settings;
  const reqs = await recordApproved(ctx);
  let budget = within(s.per_run, 1, 100, 20), queued = 0, skipped = 0;
  for (const r of reqs) {
    if (budget <= 0) break;
    if (r.kind === "gift-card" && r.status === "new") {
      if (!validCents(r.amount_cents)) { await skip(ctx, r, "amount must be whole cents from AUD 1.00 to AUD 5,000.00"); skipped++; continue; }
      if (r.customer_id && !ID.test(r.customer_id)) { await skip(ctx, r, "customer id is not a plain Square id"); skipped++; continue; }
      const id = await ctx.queue(issueCardAct(s, r), `Issue a digital gift card for ${dollars(r.amount_cents)} (request ${r.key})`);
      await ctx.store.put("requests", r.key, { ...r, status: "issue-queued", approval: id } satisfies Request);
      queued++; budget--;
    } else if (r.kind === "gift-card" && r.status === "issued" && r.order_id) {
      if (!ID.test(r.order_id) || !validCents(r.amount_cents)) { await skip(ctx, r, "order id or amount is not valid for activation"); skipped++; continue; }
      const id = await ctx.queue(activateAct(s, r), `Activate gift card ${r.gift_card_id} for ${dollars(r.amount_cents!)} on order ${r.order_id}`);
      await ctx.store.put("requests", r.key, { ...r, status: "activate-queued", activate_approval: id } satisfies Request);
      queued++; budget--;
    } else if (r.kind === "loyalty-enrol" && r.status === "new") {
      if (!s.loyalty_program_id) { ctx.log("issue: loyalty enrolment waits: no loyalty_program_id in settings"); continue; }
      const hasPhone = !!r.phone && PHONE.test(r.phone), hasCustomer = !!r.customer_id && ID.test(r.customer_id);
      if (!hasPhone && !hasCustomer) { await skip(ctx, r, "needs a phone in E.164 format or a Square customer id"); skipped++; continue; }
      const id = await ctx.queue(enrolAct(s, r), `Enrol a member in the loyalty program (request ${r.key})`);
      await ctx.store.put("requests", r.key, { ...r, status: "enrol-queued", approval: id } satisfies Request);
      queued++; budget--;
    }
  }
  ctx.log(`issue: ${queued} queued for approval, ${skipped} skipped`);
  return { queued, skipped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { activity, issue, balances };
