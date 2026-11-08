// The environmental monitoring workflow's two crons. Each reads the local store or the owner's register and drafts.
// Nothing is sent by code: the one review email goes out only when a person approves the queued send (see SKILL.md).
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Reading, Settings } from "./types.ts";
import { EMAIL, esc, issues, missingFields } from "./types.ts";
import { microsoft365 } from "./adapters/microsoft-365.ts";

/** Every thirty minutes: copy each new reading or lab result into the register table, unless its row is already there. */
export async function register(ctx: Ctx<Settings>) {
  const fresh = Object.values(await ctx.store.list<Reading>("readings")).filter((r) => r.status === "new");
  if (!fresh.length) return { registered: 0, skipped: 0, needs_check: 0 };
  const have = await microsoft365.registeredIds(ctx);
  let registered = 0, skipped = 0, needsCheck = 0;
  for (const r of fresh) {
    const missing = missingFields(r);
    const now = ctx.now.toISOString();
    const next: Reading = { ...r, missing, status: missing.length ? "needs-check" : "registered", registered: now };
    if (have.has(r.id)) skipped++;
    else { await microsoft365.appendRow(ctx, next); registered++; }
    if (missing.length) needsCheck++;
    await ctx.store.put("readings", r.key, next);
  }
  ctx.log(`register: ${registered} written, ${skipped} already there, ${needsCheck} need a check`);
  return { registered, skipped, needs_check: needsCheck };
}

/** Every day: check each registered result against its limit. Anything that fails goes into one review email, drafted now and queued for approval. */
export async function review(ctx: Ctx<Settings>) {
  const to = ctx.settings.microsoft_365.qc_email;
  if (!to || !EMAIL.test(to)) { ctx.log("review: no qc_email set, nothing drafted"); return { flagged: 0, checked: 0 }; }
  const now = ctx.now.toISOString();
  const limits = ctx.settings.limits ?? [];
  const open: { r: Reading; list: string[] }[] = [];
  let checked = 0;
  for (const r of Object.values(await ctx.store.list<Reading>("readings"))) {
    if ((r.status !== "registered" && r.status !== "needs-check") || r.flagged) continue;
    const list = issues(r, limits);
    if (list.length) open.push({ r, list });
    else { await ctx.store.put("readings", r.key, { ...r, status: "checked", checked: now }); checked++; }
  }
  if (!open.length) return { flagged: 0, checked };
  open.sort((a, b) => a.r.key.localeCompare(b.r.key));
  const items = open.map(({ r, list }) => `<li>${esc(r.id)} (${esc(r.site)}, ${esc(r.point)}, ${esc(r.parameter)}, ${esc(r.date)}): ${esc(list.join("; "))}</li>`).join("");
  const html = `<p>${open.length} monitoring result${open.length === 1 ? "" : "s"} need a person's check before the register is complete.</p><ul>${items}</ul>`;
  const subject = `Environmental monitoring results to check (${open.length})`;
  const messageId = await microsoft365.qcDraft(ctx, to, subject, html);
  // The key is the set of results, so a second run with the same set never queues a second send.
  await ctx.queue(microsoft365.sendAct(ctx, messageId, to, `review:${open.map(({ r }) => r.key).join("|")}`), `Send monitoring review list (${open.length} results) to ${to}`);
  for (const { r, list } of open) await ctx.store.put("readings", r.key, { ...r, status: "needs-check", issue: list.join("; "), flagged: now });
  ctx.log(`review: ${open.length} flagged, ${checked} checked, QC draft ${messageId}`);
  return { flagged: open.length, checked };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { register, review };
