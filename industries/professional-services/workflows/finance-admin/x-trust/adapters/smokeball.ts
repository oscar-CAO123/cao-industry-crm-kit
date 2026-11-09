// Smokeball: the trust ledger lives per matter inside a bank account. Reads are draft operations; a requisition
// (a payment out of trust) is a live operation that a person approves. Field names come from docs.smokeball.com/openapi.json.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { MatterBalance, Request, Settings, Transaction } from "../types.ts";

const P = "smokeball";

/** Smokeball ids are GUIDs. Anything else is refused before it reaches a path or a body. */
export const platformId = (v: unknown, what: string): string => {
  const s = String(v ?? "");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) throw new Error(`x-trust: bad ${what}`);
  return s;
};
/** Dollars and cents only, above zero, below ten million. */
export const dollars = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000 || Number(n.toFixed(2)) !== n) throw new Error("x-trust: bad amount");
  return n;
};
/** The spec types the list responses loosely: accept a bare array or a value collection. */
const rows = (d: any): any[] => (Array.isArray(d) ? d : Array.isArray(d?.value) ? d.value : []);

export async function matterBalances(ctx: Ctx<Settings>, accountId: string): Promise<MatterBalance[]> {
  const r = await ctx.draft<any>({ platform: P, op: "GetBankAccountMatterBalances", summary: "matter balances on a trust account",
    input: { params: { id: platformId(accountId, "trust account"), Limit: 200 } } });
  if (r.data?.next) ctx.log(`x-trust: ${accountId} has more matter balances than one page`);
  return rows(r.data).map((b) => ({ matter_id: b.matter?.id ?? null, balance: Number(b.balance), available: Number(b.availableBalance) }));
}

/** Every page of trust transactions, up to a cap. The spec pages with Offset and Limit; a short page is the last one. */
const TX_PAGE = 200, TX_MAX_PAGES = 25;
export async function transactions(ctx: Ctx<Settings>, accountId: string): Promise<Transaction[]> {
  const out: Transaction[] = [];
  for (let page = 0; page < TX_MAX_PAGES; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "GetTransactions", summary: "trust transactions on a trust account",
      input: { params: { bankAccountId: platformId(accountId, "trust account"), Offset: page * TX_PAGE, Limit: TX_PAGE } } });
    const batch = rows(r.data);
    out.push(...batch.map((t) => ({ id: String(t.id), type: t.type ?? null, amount: Number(t.amount), matter_id: t.matter?.id ?? null, entered: t.enteredDate ?? null })));
    if (batch.length < TX_PAGE) return out;
  }
  ctx.log(`x-trust: ${accountId} has more than ${TX_MAX_PAGES * TX_PAGE} transactions; only the first ${TX_MAX_PAGES * TX_PAGE} were read`);
  return out;
}

/** The live act for a disbursement: queued by the cron, run only after a person approves it. */
export function requisitionAct(ctx: Ctx<Settings>, r: Request): Act {
  const body: Record<string, unknown> = {
    matterId: platformId(r.matter_id, "matter"),
    payeeId: platformId(r.payee_id, "payee"),
    source: "Bank Transfer",
    amount: dollars(r.amount),
    effectiveDate: ctx.now.toISOString(),
    ...(r.reference ? { reference: String(r.reference).slice(0, 255) } : {}),
    ...(r.reason ? { reason: String(r.reason).slice(0, 255) } : {}),
    ...(ctx.settings.approver_user_id ? { approverUserId: platformId(ctx.settings.approver_user_id, "approver") } : {}),
  };
  return { platform: P, op: "CreateRequisitionAsync", key: `req:${r.id}`, summary: `pay ${r.amount} from trust to payee for matter ${r.matter_id}`,
    input: { params: { id: platformId(r.account_id, "trust account") }, body } };
}
