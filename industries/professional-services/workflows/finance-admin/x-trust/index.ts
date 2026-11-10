// The trust accounting workflow's three crons. Each reads, flags or queues. None of them moves money:
// a disbursement is queued for a person to approve, and the approval is the only thing that runs it.
// Judgment (why a receipt has no matter, whether a payment is owed) belongs to the person in the CRM shell.
import { safeKey, approvalId, type Approval, type Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Flag, MatterBalance, Request, Settings } from "./types.ts";
import { matterBalances, requisitionAct, transactions, dollars } from "./adapters/smokeball.ts";

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Cents already promised from one matter's trust balance by requisitions that have not finished: queued, running, or
 *  needing a check (any of which may still go out). `exceptId` is the approval for the request being checked. */
async function reservedCents(ctx: Ctx<Settings>, accountId: string, matterId: string, exceptId: string): Promise<number> {
  let cents = 0;
  for (const [id, ap] of Object.entries(await ctx.store.list<Approval>("approvals"))) {
    if (ap.workflow !== ctx.workflow.id || id === exceptId || !["pending", "running", "needs-check"].includes(ap.status)) continue;
    for (const a of ap.acts) {
      const body = a.input?.body as { matterId?: string; amount?: number } | undefined;
      if (a.op === "CreateRequisitionAsync" && (a.input?.params as { id?: string } | undefined)?.id === accountId && body?.matterId === matterId) {
        cents += Math.round(Number(body.amount) * 100);
      }
    }
  }
  return cents;
}

/** Daily: read the matter balances on each trust account and flag any matter below the floor. */
export async function balances(ctx: Ctx<Settings>) {
  const floor = ctx.settings.min_matter_balance ?? 0;
  let flagged = 0;
  for (const acct of ctx.settings.trust_accounts) {
    const rows = await matterBalances(ctx, acct.id);
    await ctx.store.put("balances", safeKey(acct.id), { at: ctx.now.toISOString(), rows });
    for (const b of rows) {
      if (!b.matter_id || b.balance >= floor) continue;
      const key = safeKey(`neg:${acct.id}:${b.matter_id}`);
      if (await ctx.store.get("flags", key)) continue;   // a flag stays until a person clears it: no duplicates
      await ctx.store.put("flags", key, { key, kind: "negative-matter-balance", account_id: acct.id, matter_id: b.matter_id, amount: b.balance, raised: ctx.now.toISOString() } satisfies Flag);
      flagged++;
    }
  }
  ctx.log(`balances: ${flagged} flagged`);
  return { flagged };
}

/** Every 30 minutes: read trust transactions and flag each new one that has no matter allocated. */
export async function receipts(ctx: Ctx<Settings>) {
  let flagged = 0;
  for (const acct of ctx.settings.trust_accounts) {
    for (const t of await transactions(ctx, acct.id)) {
      const seen = safeKey(`${acct.id}:${t.id}`);
      if (await ctx.store.get("receipts", seen)) continue;
      // The flag is written before the transaction is marked seen: a crash between the two writes repeats the check, never drops the flag.
      if (!t.matter_id) {
        const key = safeKey(`unalloc:${acct.id}:${t.id}`);
        if (!(await ctx.store.get("flags", key))) {
          await ctx.store.put("flags", key, { key, kind: "unallocated-transaction", account_id: acct.id, transaction_id: t.id, amount: t.amount, raised: ctx.now.toISOString() } satisfies Flag);
          flagged++;
        }
      }
      await ctx.store.put("receipts", seen, { at: ctx.now.toISOString() });
    }
  }
  ctx.log(`receipts: ${flagged} flagged`);
  return { flagged };
}

/** Every 15 minutes: check each recorded disbursement against the matter's trust balance, then queue it for approval. */
export async function disbursements(ctx: Ctx<Settings>) {
  const open = Object.values(await ctx.store.list<Request>("requests")).filter((r) => r.status === "requested");
  const known = new Set(ctx.settings.trust_accounts.map((a) => a.id));
  const cache = new Map<string, MatterBalance[]>();
  let queued = 0, parked = 0;
  for (const r of open) {
    const park = async (why: string) => { parked++; await ctx.store.put("requests", r.id, { ...r, status: "needs-check", reason_parked: why } satisfies Request); };
    if (!known.has(r.account_id)) { await park("not one of this business's trust accounts"); continue; }
    let act;
    try { act = requisitionAct(ctx, r); } catch (e) { await park((e as Error).message); continue; }
    if (!cache.has(r.account_id)) cache.set(r.account_id, await matterBalances(ctx, r.account_id));
    const m = cache.get(r.account_id)!.find((b) => b.matter_id === r.matter_id);
    // The balance read is what Smokeball holds; requisitions already waiting for approval are not in it yet, so they are taken off here.
    const reserved = await reservedCents(ctx, r.account_id, r.matter_id, approvalId(ctx.workflow.id, act.key ?? ""));
    const freeCents = m ? Math.round(m.available * 100) - reserved : 0;
    if (!m || freeCents < Math.round(dollars(r.amount) * 100)) {
      await park(`trust balance on the matter is ${m ? money(freeCents / 100) : "not found"} after approvals already waiting, below ${money(r.amount)}`);
      continue;
    }
    await ctx.queue(act, `Pay ${money(r.amount)} from trust for matter ${r.matter_id}${r.reference ? ` (${r.reference})` : ""}`);
    await ctx.store.put("requests", r.id, { ...r, status: "queued" } satisfies Request);
    queued++;
  }
  ctx.log(`disbursements: ${queued} queued, ${parked} parked`);
  return { queued, parked };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { balances, receipts, disbursements };
