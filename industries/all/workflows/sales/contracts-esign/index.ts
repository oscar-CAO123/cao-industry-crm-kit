// The contracts e-signature workflow's three crons. Each is deterministic: it reads, drafts and queues; it never sends.
// Judgment (preparing the PDF, deciding who signs and in what order) belongs to the person or skill that writes the
// agreement record. The record is checked here before any envelope is drafted.
import type { Ctx, Approval } from "../../../../../core/workflows/runtime.ts";
import type { Agreement, Settings, Status } from "./types.ts";
import { checkAgreement } from "./types.ts";
import { createDraft, sendAct, fetchStatus } from "./adapters/docusign.ts";

const OPEN = ["sent", "delivered", "signed"];
const KNOWN = ["sent", "delivered", "signed", "completed", "declined", "voided"];

/** Every 15 minutes: check each new agreement, then save it in DocuSign as a draft envelope. Nothing is emailed. */
export async function prepare(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Agreement>("agreements")).filter((a) => a.status === "new");
  let drafted = 0, held = 0;
  for (const a of todo) {
    const bad = checkAgreement(a);
    if (bad) { held++; await ctx.store.put("agreements", a.id, { ...a, status: "needs-check", reason: bad } satisfies Agreement); continue; }
    const envelope = await createDraft(ctx, a);
    await ctx.store.put("agreements", a.id, { ...a, status: "drafted", envelope, reason: undefined } satisfies Agreement);
    drafted++;
  }
  ctx.log(`prepare: ${drafted} drafted, ${held} need checking`);
  return { drafted, needs_check: held };
}

/** Every 30 minutes: queue each drafted envelope's send for a person to approve. The cron never sends. */
export async function dispatch(ctx: Ctx<Settings>) {
  let queued = 0;
  for (const a of Object.values(await ctx.store.list<Agreement>("agreements"))) {
    if (a.status !== "drafted" || !a.envelope) continue;
    const who = a.signers.map((s) => s.email).join(", ");
    const id = await ctx.queue(sendAct(a), `Send "${a.title}" for signature to ${a.signers.length} signer${a.signers.length === 1 ? "" : "s"}: ${who}`);
    await ctx.store.put("agreements", a.id, { ...a, status: "awaiting-approval", approval: id } satisfies Agreement);
    queued++;
  }
  ctx.log(`dispatch: ${queued} queued for approval`);
  return { queued };
}

/** Hourly: mark approved sends as sent, then read each open envelope's status back from DocuSign. Never sends. */
export async function status(ctx: Ctx<Settings>) {
  for (const a of Object.values(await ctx.store.list<Agreement>("agreements"))) {
    if (a.status !== "awaiting-approval" || !a.approval) continue;
    const ap = await ctx.store.get<Approval>("approvals", a.approval);
    if (!ap) continue;
    const sent = ap.status === "done" || (ap.results?.[0]?.status ?? 999) < 300;
    if (sent) await ctx.store.put("agreements", a.id, { ...a, status: "sent", sent_at: ap.started ?? ap.decided } satisfies Agreement);
    else if (ap.status !== "pending" && ap.status !== "running")
      await ctx.store.put("agreements", a.id, { ...a, status: "needs-check", reason: `send ${ap.status}: check the envelope in DocuSign before anything else` } satisfies Agreement);
  }
  const limit = ctx.settings.status_check_limit ?? 50;
  const open = Object.values(await ctx.store.list<Agreement>("agreements")).filter((a) => OPEN.includes(a.status) && a.envelope).slice(0, limit);
  let changed = 0;
  for (const a of open) {
    const e = await fetchStatus(ctx, a.envelope!);
    if (!KNOWN.includes(e.status) || e.status === a.status) continue;
    const next: Agreement = { ...a, status: e.status as Status };
    if (e.status === "completed") next.completed_at = e.completedDateTime ?? ctx.now.toISOString();
    await ctx.store.put("agreements", a.id, next);
    changed++;
  }
  ctx.log(`status: ${changed} changed`);
  return { changed };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { prepare, dispatch, status };
