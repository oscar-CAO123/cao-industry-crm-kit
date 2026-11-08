// The owner contacts workflow's three crons. Each reads VaultRE or drafts an email in the agency mailbox. None sends.
// A send is only ever queued (live operation) and runs when a person approves it in the CRM shell.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Owner, Settings } from "./types.ts";
import * as vaultre from "./adapters/vaultre.ts";
import { mailDraft, esc } from "./adapters/microsoft-365.ts";

const DEFAULT_BODY = "Hi {first_name}, this is {business_name}. If you would like a no-obligation chat about your property's options, reply to this email. To be removed from our list, reply STOP and we will take you off.";

/** A positive whole number from settings, capped; the default when it is missing or wrong. */
const cap = (v: unknown, dflt: number, max: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt; };

/** Reads the owner's VaultRE record and consent, and returns the owner with its new status. Never writes to VaultRE. */
async function checkOwner(ctx: Ctx<Settings>, o: Owner): Promise<Owner> {
  const now = ctx.now.toISOString();
  const c = await vaultre.getContact(ctx, o.id);
  if (!c) return { ...o, status: "blocked", checked: now, reason: "owner record not found in VaultRE" };
  const base: Owner = { ...o, name: vaultre.ownerName(c), email: vaultre.ownerEmail(c), mobile: vaultre.ownerMobile(c), checked: now, reason: undefined };
  if (c.onDoNotCallList) return { ...base, status: "blocked", reason: "on the do-not-call list in VaultRE" };
  if (c.unsubscribe?.email) return { ...base, status: "blocked", reason: "opted out of email in VaultRE" };
  const consent = await vaultre.consentOf(ctx, o.id);
  if (!consent.email) return { ...base, status: "no-consent", reason: "no email consent on record" };
  if (!base.email) return { ...base, status: "no-consent", reason: "no valid email address on record" };
  return { ...base, status: "eligible" };
}

/** Every 20 minutes past the hour: add each current owner the workflow has not seen. Nothing is contacted. */
export async function ownerList(ctx: Ctx<Settings>) {
  const now = ctx.now.toISOString();
  let added = 0;
  for (const id of await vaultre.currentOwnerIds(ctx)) {
    if (await ctx.store.get<Owner>("owners", id)) continue;
    await ctx.store.put("owners", id, { id, name: "", status: "new", first_seen: now } satisfies Owner);
    added++;
  }
  ctx.log(`owner-list: ${added} added`);
  return { added };
}

/** Every three hours: check each new owner's record and consent. Each owner ends eligible, no-consent or blocked. */
export async function consentCheck(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Owner>("owners")).filter((o) => o.status === "new")
    .sort((a, b) => a.first_seen.localeCompare(b.first_seen)).slice(0, cap(ctx.settings.owners_per_run, 25, 100));
  const counts = { eligible: 0, "no-consent": 0, blocked: 0 } as Record<string, number>;
  for (const o of todo) {
    const next = await checkOwner(ctx, o);
    await ctx.store.put("owners", o.id, next);
    counts[next.status] = (counts[next.status] ?? 0) + 1;
  }
  ctx.log(`consent-check: ${todo.length} checked, ${counts.eligible} eligible, ${counts["no-consent"]} no consent, ${counts.blocked} blocked`);
  return { checked: todo.length, ...counts };
}

/** Daily: re-check each eligible owner, draft an email to each one still eligible, and queue its send for approval. */
export async function outreach(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Owner>("owners")).filter((o) => o.status === "eligible")
    .sort((a, b) => a.first_seen.localeCompare(b.first_seen)).slice(0, cap(ctx.settings.daily_limit, 20, 100));
  let queued = 0, stopped = 0;
  for (const o of todo) {
    // Consent can change after the last check, so each owner is read again before anything is drafted.
    const fresh = await checkOwner(ctx, o);
    if (fresh.status !== "eligible" || !fresh.email) { await ctx.store.put("owners", o.id, fresh); stopped++; continue; }
    const first = fresh.name.split(" ")[0] || "there";
    const plain = (ctx.settings.outreach_body ?? DEFAULT_BODY).replace("{first_name}", first).replace("{business_name}", ctx.settings.business_name ?? "our team");
    const subject = (ctx.settings.outreach_subject ?? "Checking in about your property").slice(0, 120);
    const d = await mailDraft(ctx, fresh.email, subject, `<p>${esc(plain)}</p>`);
    const approval = await ctx.queue({ ...d.send, key: `outreach:${fresh.id}` }, `Email ${fresh.name || fresh.id} at ${fresh.email}: outreach email from the agency mailbox`);
    await ctx.store.put("owners", fresh.id, { ...fresh, status: "queued", approval } satisfies Owner);
    queued++;
  }
  ctx.log(`outreach: ${queued} queued, ${stopped} stopped at re-check`);
  return { queued, stopped };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { "owner-list": ownerList, "consent-check": consentCheck, outreach };
