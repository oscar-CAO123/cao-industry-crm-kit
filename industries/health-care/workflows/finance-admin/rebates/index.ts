// The missed rebates workflow's two crons. Both read only: pull reads the practice system and the ledger, flag lists
// what a person should check. Nothing here lodges, chases, sends or changes a record.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Flag, InvoiceRow, PaymentRow, Settings } from "./types.ts";
import { listInvoices, invoiceItems, toRow } from "./adapters/cliniko.ts";
import { payments } from "./adapters/xero.ts";

const DAY = 864e5;
const OPEN = 10;                 // Cliniko invoice status: Open (nothing paid yet)
const MAX_NEW_ITEM_LOOKUPS = 100; // invoice-item reads per run, so a first run stays inside the timeout

/** Every 6 hours: read invoices and their items from Cliniko, and payments from Xero. Reads only. */
export async function pull(ctx: Ctx<Settings>) {
  const have = await ctx.store.list<InvoiceRow>("invoices");
  let seen = 0, itemReads = 0;
  for (const inv of await listInvoices(ctx)) {
    const id = String(inv.id ?? "");
    if (!/^\d{1,18}$/.test(id)) continue;
    seen++;
    const known = have[`cliniko:${id}`];
    let codes = known?.codes;
    if (!codes) {
      if (itemReads >= MAX_NEW_ITEM_LOOKUPS) continue;   // picked up on a later run
      itemReads++;
      codes = toRow(inv, await invoiceItems(ctx, id)).codes;
    }
    await ctx.store.put("invoices", `cliniko:${id}`, { ...toRow(inv, []), codes } satisfies InvoiceRow);
  }
  const pays = await payments(ctx);
  await ctx.store.put("payments", "latest", { at: ctx.now.toISOString(), rows: pays });
  ctx.log(`pull: ${seen} invoices seen, ${itemReads} item reads, ${pays.length} payments`);
  return { invoices_seen: seen, item_reads: itemReads, payments: pays.length };
}

/** Daily: list open invoices with a rebate item, older than the review window, that Xero shows no payment against. */
export async function flag(ctx: Ctx<Settings>) {
  const codes = new Set((ctx.settings.rebate_codes ?? []).map((c) => c.toUpperCase()));
  if (!codes.size) return { flagged: 0, reason: "no rebate codes set in settings" };
  const days = ctx.settings.review_after_days ?? 14;
  const paid = new Set(((await ctx.store.get<{ rows: PaymentRow[] }>("payments", "latest"))?.rows ?? []).map((p) => p.invoice_number));
  let flagged = 0;
  for (const row of Object.values(await ctx.store.list<InvoiceRow>("invoices"))) {
    if (row.status !== OPEN) continue;
    const hit = row.codes.filter((c) => codes.has(c.toUpperCase()));
    if (!hit.length) continue;
    const made = Date.parse(row.created_at);
    if (!Number.isFinite(made) || ctx.now.getTime() - made < days * DAY) continue;
    if (paid.has(String(row.number))) continue;
    const key = `flag:${row.key}`;
    if (await ctx.store.get("flags", key)) continue;      // listed already: a re-run never lists it twice
    await ctx.store.put("flags", key, {
      key, invoice: row.key, number: row.number, codes: hit, total_amount: row.total_amount, created_at: row.created_at,
      reason: `Open for ${days} days or more with a rebate item, and no payment in Xero. Check the claim in Cliniko.`, status: "to-check",
    } satisfies Flag);
    flagged++;
  }
  ctx.log(`flag: ${flagged} new for a person to check`);
  return { flagged };
}

export const CRONS = { pull, flag };
