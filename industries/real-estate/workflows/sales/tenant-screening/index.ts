// The tenant screening workflow's three crons. Each is deterministic: it reads, sets the applicant's status, and
// queues a tenancy for approval. It never sends a message and never creates a tenancy by itself.
// The screening checks (ID, income, references, credit, guarantor) are judgment steps done outside the platform
// (see SKILL.md); their result reaches the store as status "approved" with lease dates.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import { approvalId, type Approval } from "../../../../../core/workflows/runtime.ts";
import type { Applicant, Settings } from "./types.ts";
import { keyOf } from "./types.ts";
import { applicantContacts, readContact, tenancyBody } from "./adapters/re-leased.ts";

/** Every 30 minutes: new applicant contacts from Re-Leased (tagged as applicants) into the store. */
export async function intake(ctx: Ctx<Settings>) {
  const last = await ctx.store.get<{ at: string }>("state", "intake");
  const { rows, complete } = await applicantContacts(ctx, last?.at);
  let added = 0;
  for (const a of rows) {
    if (await ctx.store.get("applicants", a.id)) continue;
    await ctx.store.put("applicants", a.id, a);
    added++;
  }
  // The cursor moves only once every page has been read, so no applicant updated in the window is skipped.
  if (complete) await ctx.store.put("state", "intake", { at: ctx.now.toISOString() });
  else ctx.log("intake: more applicant pages than one run reads, cursor held");
  ctx.log(`intake: ${added} new`);
  return { added };
}

/** Every 30 minutes: read each new applicant's Re-Leased record and move it on to the checks, or park it when the record has no usable email. */
export async function checkRecord(ctx: Ctx<Settings>) {
  const todo = Object.values(await ctx.store.list<Applicant>("applicants")).filter((a) => a.status === "new" || a.status === "needs-contact-details");
  let ready = 0, parked = 0;
  for (const a of todo) {
    const c = await readContact(ctx, a.id);
    if (!c) { await ctx.store.put("applicants", a.id, { ...a, status: "needs-contact-details", reason: "contact not found in Re-Leased" }); parked++; continue; }
    const email = c.email ?? a.email;
    if (!email) { await ctx.store.put("applicants", a.id, { ...a, status: "needs-contact-details", reason: "no valid email on the contact" }); parked++; continue; }
    await ctx.store.put("applicants", a.id, { ...a, name: c.name ?? a.name, email, status: "awaiting-checks", reason: undefined });
    ready++;
  }
  ctx.log(`check-record: ${ready} awaiting checks, ${parked} parked`);
  return { awaiting_checks: ready, parked };
}

/** Every 30 minutes: an applicant a person has approved gets a tenancy queued for approval. The queue de-duplicates by applicant
 *  and attempt, so a re-run never queues twice. A rejected tenancy sends the applicant back to awaiting-checks; a person approves
 *  them again to queue a new one. One bad applicant is logged and skipped, and the rest still run. */
export async function lease(ctx: Ctx<Settings>) {
  const approved = Object.values(await ctx.store.list<Applicant>("applicants")).filter((a) => a.status === "approved");
  let queued = 0;
  for (const a of approved) {
    try {
      const attempt = (await ctx.store.get<{ n: number }>("lease-tries", a.id))?.n ?? 0;
      const suffix = attempt ? `:${attempt}` : "";
      const key = `lease:${a.id}${suffix}`;
      if ((await ctx.store.get<Approval>("approvals", approvalId(ctx.workflow.id, key)))?.status === "rejected") {
        await ctx.store.put("lease-tries", a.id, { n: attempt + 1 });
        await ctx.store.put("applicants", a.id, { ...a, status: "awaiting-checks", reason: "tenancy was rejected: approve the applicant again to queue a new one" } satisfies Applicant);
        ctx.log(`lease: ${keyOf(a.id)} tenancy was rejected, back to awaiting-checks`);
        continue;
      }
      const body = tenancyBody(ctx, a);
      const summary = `create tenancy "${body.Title}" from ${body.StartDate.slice(0, 10)} to ${body.EndDate.slice(0, 10)}`;
      await ctx.queue({ platform: "re-leased", op: "Tenancies_Post", key, summary,
        input: { params: { "Idempotency-Key": `lease-${a.id}${suffix ? `-${attempt}` : ""}` }, body } }, summary);
      queued++;
    } catch (e: any) {
      ctx.log(`lease: ${keyOf(a.id)} skipped: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  ctx.log(`lease: ${queued} approved applicants checked for a queued tenancy`);
  return { checked: queued };
}

export const CRONS: Record<string, (ctx: Ctx<Settings>) => Promise<unknown>> = { intake, "check-record": checkRecord, lease };
