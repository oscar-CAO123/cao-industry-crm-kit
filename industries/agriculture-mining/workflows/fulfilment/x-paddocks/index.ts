// The paddock records workflow's three crons. register and paddock-read read and draft; review drafts one QC email and
// only queues its send. Nothing here sends by itself (see SKILL.md).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { type Settings, type JobRecord, type Paddock, EMAIL, esc, keyOf, missingFields } from "./types.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";
import { paddocksFor } from "./adapters/agriwebb.ts";

/** Every thirty minutes: copy each new job record into the register workbook, unless its row is already there. */
export async function register(ctx: Ctx<Settings>) {
  const fresh = Object.values(await ctx.store.list<JobRecord>("records")).filter((r) => r.status === "new");
  if (!fresh.length) return { registered: 0, skipped: 0, needs_check: 0 };
  const have = await microsoft365.registeredIds(ctx);
  let registered = 0, skipped = 0, needsCheck = 0;
  for (const r of fresh) {
    const missing = missingFields(r);
    const now = ctx.now.toISOString();
    const next: JobRecord = { ...r, missing, status: missing.length ? "needs-check" : "registered", registered: now };
    if (have.has(r.id)) skipped++;
    else { await microsoft365.appendRow(ctx, next); registered++; }
    if (missing.length) needsCheck++;
    await ctx.store.put("records", r.key, next);
  }
  ctx.log(`register: ${registered} written, ${skipped} already there, ${needsCheck} need a check`);
  return { registered, skipped, needs_check: needsCheck };
}

/** Every six hours: read each watched farm's paddocks, with their crop type and land use, into the store. */
export async function paddockRead(ctx: Ctx<Settings>) {
  const rows = await paddocksFor(ctx);
  const read = ctx.now.toISOString();
  for (const p of rows) {
    const prev = await ctx.store.get<Paddock>("paddocks", keyOf(p.id));
    await ctx.store.put("paddocks", keyOf(p.id), { ...p, read, flagged: prev?.flagged });
  }
  ctx.log(`paddock-read: ${rows.length} paddocks`);
  return { paddocks: rows.length };
}

/** Every day: list the job records that need a check and the paddocks with no crop type or land use, in one QC email
 *  drafted now and queued for approval to send. Each item is listed once. */
export async function review(ctx: Ctx<Settings>) {
  const to = ctx.settings.microsoft_365.qc_email;
  if (!to || !EMAIL.test(to)) { ctx.log("review: no qc_email set, nothing drafted"); return { flagged: 0, bare_paddocks: 0 }; }
  const open = Object.values(await ctx.store.list<JobRecord>("records"))
    .filter((r) => r.status === "needs-check" && !r.flagged)
    .sort((a, b) => a.key.localeCompare(b.key));
  const bare = Object.values(await ctx.store.list<Paddock>("paddocks"))
    .filter((p) => !p.flagged && !p.cropType && !p.landUse)
    .sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)));
  if (!open.length && !bare.length) return { flagged: 0, bare_paddocks: 0 };
  const recs = open.map((r) => `<li>${esc(r.id)} (${esc(r.kind)}, ${esc(r.date)}, ${esc(r.paddock)}): missing ${esc((r.missing ?? []).join(", "))}</li>`).join("");
  const pads = bare.map((p) => `<li>${esc(p.name ?? p.id)}: no crop type or land use set in AgriWebb</li>`).join("");
  const parts = [`<p>Paddock records to check.</p>`];
  if (open.length) parts.push(`<p>${open.length} job record${open.length === 1 ? "" : "s"} need a check before the register is complete.</p><ul>${recs}</ul>`);
  if (bare.length) parts.push(`<p>${bare.length} paddock${bare.length === 1 ? "" : "s"} with no crop type or land use.</p><ul>${pads}</ul>`);
  const subject = `Paddock records to check (${open.length + bare.length})`;
  const messageId = await microsoft365.qcDraft(ctx, to, subject, parts.join(""));
  // The key is the set of items, so a second run with the same set never queues a second send.
  const key = `qc:${open.map((r) => r.key).join("|")}|${bare.map((p) => keyOf(p.id)).join("|")}`;
  await ctx.queue(microsoft365.sendAct(ctx, messageId, to, key), `Send paddock QC list (${open.length + bare.length} items) to ${to}`);
  const now = ctx.now.toISOString();
  for (const r of open) await ctx.store.put("records", r.key, { ...r, flagged: now });
  for (const p of bare) await ctx.store.put("paddocks", keyOf(p.id), { ...p, flagged: now });
  ctx.log(`review: ${open.length} records and ${bare.length} paddocks flagged, QC draft ${messageId}`);
  return { flagged: open.length, bare_paddocks: bare.length };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { register, paddockRead, review };
