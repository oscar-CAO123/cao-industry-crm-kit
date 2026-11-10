// Xero for the missing documents finder. Reads only: bank transactions and bills that are AUTHORISED in the lookback
// window and have no attachment, plus the client contact for each one. Nothing here writes to Xero.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import { GUID, EMAIL, DAY, lookback, keyOf, type Missing, type Settings } from "../types.ts";

const P = "xero";
const PAGE = 100;
const MAX_PAGES = 20;

/** The Xero where-filter from validated numbers only. The window starts at the lookback, in UTC. */
export function sinceFilter(days: number, now: Date, extra: string): string {
  const from = new Date(now.getTime() - days * DAY);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${extra} AND Date>=DateTime(${from.getUTCFullYear()},${two(from.getUTCMonth() + 1)},${two(from.getUTCDate())})`;
}

async function readAll(ctx: Ctx<Settings>, op: "accounting.getBankTransactions" | "accounting.getInvoices", where: string, field: "BankTransactions" | "Invoices") {
  const out: any[] = [];
  let more = true;
  for (let page = 1; page <= MAX_PAGES && more; page++) {
    const r = await ctx.draft<any>({ platform: P, op, summary: `${field} page ${page}`, input: { params: { where, order: "Date DESC", page, pageSize: PAGE } } });
    const rows: any[] = Array.isArray(r.data?.[field]) ? r.data[field] : [];
    out.push(...rows);
    more = rows.length === PAGE;
  }
  // A full last page means rows are still waiting: refuse, so the scan never clears items from a partial list.
  if (more) throw new Error(`xero: ${field} has more than ${MAX_PAGES * PAGE} rows in the lookback: scan refused`);
  return out;
}

/** Client names and emails for the contact IDs seen, read in batches of 50. A contact with no valid email is kept, never chased. */
async function contacts(ctx: Ctx<Settings>, ids: string[]): Promise<Map<string, { name?: string; email?: string }>> {
  const found = new Map<string, { name?: string; email?: string }>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await ctx.draft<any>({ platform: P, op: "accounting.getContacts", summary: `client contacts ${chunk.length}`, input: { params: { IDs: chunk } } });
    for (const c of Array.isArray(r.data?.Contacts) ? r.data.Contacts : []) {
      const id = String(c?.ContactID ?? "");
      if (!GUID.test(id)) continue;
      const mail = String(c.EmailAddress ?? "").trim();
      found.set(id, { name: c.Name ? String(c.Name).slice(0, 200) : undefined, email: EMAIL.test(mail) ? mail : undefined });
    }
  }
  return found;
}

/** Every item in the lookback with no document attached. Reads only. */
export async function openItems(ctx: Ctx<Settings>): Promise<Missing[]> {
  const days = lookback(ctx.settings);
  const txns = await readAll(ctx, "accounting.getBankTransactions", sinceFilter(days, ctx.now, `Status=="AUTHORISED"`), "BankTransactions");
  const bills = await readAll(ctx, "accounting.getInvoices", sinceFilter(days, ctx.now, `Type=="ACCPAY" AND Status=="AUTHORISED"`), "Invoices");
  const rows: { kind: Missing["kind"]; t: any }[] = [
    ...txns.filter((t) => t?.HasAttachments !== true && (t?.Type === "SPEND" || t?.Type === "RECEIVE")).map((t) => ({ kind: "bank-transaction" as const, t })),
    ...bills.filter((b) => b?.HasAttachments !== true && b?.Type === "ACCPAY").map((b) => ({ kind: "bill" as const, t: b })),
  ];
  const ids = [...new Set(rows.map((r) => String(r.t.Contact?.ContactID ?? "")).filter((x) => GUID.test(x)))];
  const people = await contacts(ctx, ids);
  const out: Missing[] = [];
  for (const { kind, t } of rows) {
    const xid = String(kind === "bill" ? t.InvoiceID ?? "" : t.BankTransactionID ?? "");
    if (!GUID.test(xid)) continue;
    const cid = String(t.Contact?.ContactID ?? "");
    const who = GUID.test(cid) ? people.get(cid) : undefined;
    const first: any = Array.isArray(t.LineItems) ? t.LineItems[0] ?? {} : {};
    out.push({
      key: keyOf(`xero:${kind}:${xid}`), kind, xero_id: xid,
      contact_id: GUID.test(cid) ? cid : undefined,
      contact: who?.name ?? (t.Contact?.Name ? String(t.Contact.Name).slice(0, 200) : undefined),
      email: who?.email,
      date: String(t.Date ?? "").slice(0, 10),
      reference: t.Reference ? String(t.Reference).slice(0, 200) : undefined,
      description: first.Description ? String(first.Description).slice(0, 200) : undefined,
      amount: Number(t.Total ?? 0),
      seen: "", status: "missing",
    });
  }
  return out;
}
