// The trust reconciliation crons. Each reads VaultRE and drafts internal records; the one email is queued and sent only when the principal approves it.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { safeKey } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type Tx, type Account, NUM, EMAIL, day, esc, missing } from "./types.ts";
import { vaultre } from "./adapters/vaultre.ts";
import { mailDraft, registerRow } from "./adapters/microsoft-365.ts";

/** Daily: keep the trust account list in step with VaultRE and add a register row when an account is added or dropped. Reads and drafts only. */
export async function accounts(ctx: Ctx<Settings>) {
  const today = day(ctx.now);
  const now = await vaultre.trustAccounts(ctx);
  const seen = await ctx.store.list<Account>("accounts");
  const ids = new Set(now.map((a) => a.id));
  const added = now.filter((a) => !seen[a.id]?.active);
  const dropped = Object.values(seen).filter((a) => a.active && !ids.has(a.id));
  if (added.length || dropped.length) {
    await registerRow(ctx, [today, "trust accounts",
      `added: ${added.map((a) => `${a.id} ${a.name}`).join("; ") || "none"}`,
      `dropped: ${dropped.map((a) => `${a.id} ${a.name}`).join("; ") || "none"}`]);
  }
  for (const a of added) await ctx.store.put("accounts", a.id, { id: a.id, name: a.name, active: true, seen: today } satisfies Account);
  for (const a of dropped) await ctx.store.put("accounts", a.id, { ...a, active: false, seen: today } satisfies Account);
  ctx.log(`accounts: ${now.length} trust accounts, ${added.length} added, ${dropped.length} dropped`);
  return { accounts: now.length, added: added.length, dropped: dropped.length };
}

/** Daily: read each configured sale's trust ledger, keep the entries not seen before, write one register row per sale with new entries,
 *  and draft one exceptions email for entries missing a receipt number, contact or trust account. Nothing is sent. */
export async function ledger(ctx: Ctx<Settings>) {
  const today = day(ctx.now);
  const lives = ctx.settings.sale_lives ?? [];
  const principal = ctx.settings.principal_email;
  // Read every sale first. Nothing is written until the principal's address is known to be valid, so a missing setting stops the run
  // before any register row or saved entry, and the next run sees the same entries as new.
  const batches: { sale: string; added: Tx[]; bad: Tx[] }[] = [];
  for (const s of lives) {
    if (!NUM.test(String(s.property_id)) || !NUM.test(String(s.life_id))) throw new Error("ledger: sale_lives needs numeric property_id and life_id");
    const txs = await vaultre.ledger(ctx, s.property_id, s.life_id);
    const added: Tx[] = [];
    for (const t of txs) if (!(await ctx.store.get("trust_tx", t.id))) added.push(t);
    if (!added.length) continue;
    batches.push({ sale: added[0].sale, added, bad: added.filter((t) => missing(t)) });
  }
  const flagged = batches.flatMap((b) => b.bad);
  if (flagged.length && (!principal || !EMAIL.test(principal))) throw new Error("ledger: principal_email must be a valid address before entries can be flagged");
  let fresh = 0;
  for (const b of batches) {
    const total = Math.round(b.added.reduce((n, t) => n + t.amount, 0) * 100) / 100;
    await registerRow(ctx, [today, b.sale, b.added.length, total, b.bad.length, b.bad.map((t) => t.id).join(", ")]);
    for (const t of b.added) if (!missing(t)) await ctx.store.put("trust_tx", t.id, t);
    fresh += b.added.length;
  }
  let queued = false;
  if (flagged.length) {
    const lines = flagged.map((t) => `<li>Sale ${esc(t.sale)}, entry ${esc(t.id)} (${esc(t.type || "type not given")}, ${esc(t.date || "date not given")}): ${esc(missing(t))}</li>`).join("");
    const d = await mailDraft(ctx, { to: principal!, subject: `Trust ledger: ${flagged.length} entries to check`,
      html: `<p>${esc(ctx.settings.business_name ?? "")} trust ledger check for ${esc(today)}. These new entries need a look before the reconciliation is signed off:</p><ul>${lines}</ul>` });
    await ctx.queue({ ...d.act, key: safeKey(`trust-exceptions:${today}:${flagged.map((t) => t.id).join(",")}`) },
      `trust exceptions ${today}: ${flagged.length} entries to check`);
    queued = true;
    // Flagged entries count as seen only once their exception is queued, so a failed draft is picked up again on the next run.
    for (const t of flagged) await ctx.store.put("trust_tx", t.id, t);
  }
  ctx.log(`ledger: ${fresh} new entries across ${lives.length} sales, ${flagged.length} to check`);
  return { fresh, flagged: flagged.length, queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { accounts, ledger };
