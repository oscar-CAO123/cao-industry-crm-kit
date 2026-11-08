// The spray and harvest records workflow's two crons. Each reads the local store or the owner's register and drafts.
// Nothing is sent by code: the one email goes out only when a person approves the queued send (see SKILL.md).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings, SprayRecord } from "./types.ts";
import { EMAIL, esc, missingFields } from "./types.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";

/** Every thirty minutes: copy each new record into the register workbook, unless its row is already there. */
export async function register(ctx: Ctx<Settings>) {
  const fresh = Object.values(await ctx.store.list<SprayRecord>("records")).filter((r) => r.status === "new");
  if (!fresh.length) return { registered: 0, skipped: 0, needs_check: 0 };
  const have = await microsoft365.registeredIds(ctx);
  let registered = 0, skipped = 0, needsCheck = 0;
  for (const r of fresh) {
    const missing = missingFields(r);
    const now = ctx.now.toISOString();
    const next: SprayRecord = { ...r, missing, status: missing.length ? "needs-check" : "registered", registered: now };
    if (have.has(r.id)) skipped++;
    else { await microsoft365.appendRow(ctx, next); registered++; }
    if (missing.length) needsCheck++;
    await ctx.store.put("records", r.key, next);
  }
  ctx.log(`register: ${registered} written, ${skipped} already there, ${needsCheck} need a check`);
  return { registered, skipped, needs_check: needsCheck };
}

/** Every day: list the records that need a check in one QC email, drafted now and queued for approval to send. */
export async function review(ctx: Ctx<Settings>) {
  const to = ctx.settings.microsoft_365.qc_email;
  if (!to || !EMAIL.test(to)) { ctx.log("review: no qc_email set, nothing drafted"); return { flagged: 0 }; }
  const open = Object.values(await ctx.store.list<SprayRecord>("records"))
    .filter((r) => r.status === "needs-check" && !r.flagged)
    .sort((a, b) => a.key.localeCompare(b.key));
  if (!open.length) return { flagged: 0 };
  const items = open.map((r) => `<li>${esc(r.id)} (${esc(r.kind)}, ${esc(r.date)}, ${esc(r.field)}): missing ${esc((r.missing ?? []).join(", "))}</li>`).join("");
  const html = `<p>${open.length} spray or harvest record${open.length === 1 ? "" : "s"} need a check before the register is complete.</p><ul>${items}</ul>`;
  const subject = `Spray and harvest records to check (${open.length})`;
  const messageId = await microsoft365.qcDraft(ctx, to, subject, html);
  // The key is the set of records, so a second run with the same set never queues a second send.
  await ctx.queue(microsoft365.sendAct(ctx, messageId, to, `qc:${open.map((r) => r.key).join("|")}`), `Send QC list (${open.length} records) to ${to}`);
  const now = ctx.now.toISOString();
  for (const r of open) await ctx.store.put("records", r.key, { ...r, flagged: now });
  ctx.log(`review: ${open.length} flagged, QC draft ${messageId}`);
  return { flagged: open.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { register, review };
