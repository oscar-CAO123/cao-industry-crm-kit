// VaultRE: trust accounts and each sale's trust ledger transactions. Read only.
// Field names come from the vendor spec (VaultRE swagger, schemas TrustAccount and TrustLedgerTransaction, path /properties/{propertyid}/sale/{lifeid}/trustledger/transactions).
// The spec's transaction type and category are objects with an id and a name only, so the amount's sign is not assumed.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { type Settings, type Tx, NUM, text } from "../types.ts";

const P = "vaultre";
const str = (v: unknown, n = 200) => (v === null || v === undefined || v === "" ? null : text(v, n));
const num = (v: unknown, what: string): string => { const s = String(v ?? ""); if (!NUM.test(s)) throw new Error(`vaultre: bad ${what}`); return s; };

/** Every trust account on the agency's VaultRE account: id and name only (the bank details are not read). */
export async function trustAccounts(ctx: Ctx<Settings>): Promise<{ id: string; name: string }[]> {
  const r = await ctx.draft<any>({ platform: P, op: "getTrustAccounts", summary: "trust accounts", input: { params: { pagesize: 50 } } });
  return (Array.isArray(r.data?.items) ? r.data.items : []).map((a: any) => ({ id: num(a?.id, "trust account id"), name: text(a?.name, 200) }));
}

/** Every trust ledger transaction for one sale life, page by page. */
export async function ledger(ctx: Ctx<Settings>, propertyId: string | number, lifeId: string | number): Promise<Tx[]> {
  const pid = num(propertyId, "property id"), lid = num(lifeId, "sale life id");
  const max = Math.min(ctx.settings.max_pages ?? 5, 50);
  const out: Tx[] = [];
  for (let page = 1; page <= max; page++) {
    const r = await ctx.draft<any>({ platform: P, op: "getPropertyLifeTrustLedgerTransactions", summary: `trust ledger ${pid}/${lid} page ${page}`,
      input: { params: { propertyid: pid, lifeid: lid, page, pagesize: 50 } } });
    const items: any[] = Array.isArray(r.data?.items) ? r.data.items : [];
    for (const t of items) {
      out.push({
        id: num(t?.id, "transaction id"), sale: `${pid}/${lid}`,
        account: t?.trustAccount === null || t?.trustAccount === undefined ? "" : num(t.trustAccount, "trust account id"),
        date: /^\d{4}-\d{2}-\d{2}/.test(String(t?.transactionDate ?? "")) ? String(t.transactionDate).slice(0, 10) : "",
        type: text(t?.transactionType?.name, 100), amount: Math.round(Number(t?.amount ?? 0) * 100) / 100,
        receipt: str(t?.receiptNumber, 60), contact: t?.contact === null || t?.contact === undefined ? null : str(t.contact, 60),
      });
    }
    if (!items.length || !r.data?.urls?.next) break;
  }
  return out;
}

export const vaultre = { id: P, trustAccounts, ledger };
